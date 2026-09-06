// Reading Room — main-process side.
//
// One open reader at a time: a running interactive `claude` terminal (by pid)
// whose transcript is tailed (transcripts.js) and pushed to Mission Control as
// turns. On top of that, side threads: Alp selects a passage, asks, and a
// headless sonnet run answers through rocky.js. Two ways to answer:
//
//   mini  — a fresh throwaway session that only gets the passage, the turn it
//           came from and the prompt before it. ~3–5 s, a few cents. Default.
//   fork  — `--resume <main session> --fork-session`: the tutor gets the whole
//           conversation. Measured 11.7 s and $0.45 on the first call because
//           it re-caches ~110k tokens (Fable would be $2.40 — never). One fork
//           per main session is kept and resumed for later full-context asks.
//
// Both spawn with `--setting-sources user` so the vault's project hooks
// (inbox routing, calendar) don't fire inside a tutor, and `--tools ""` so it
// can't touch anything.
//
// Electron-free; main.js injects the vault path and the event sink.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const rocky = require('./rocky');
const sessions = require('./sessions');
const transcripts = require('./transcripts');

const { firstLine } = rocky;

// Prompt-cost hygiene: hard caps on what a mini session gets to see.
const CTX_TURN_MAX = 6000;
const CTX_PREV_PROMPT_MAX = 1500;
const NOTE_SELECTION_MAX = 300;
const NOTE_ANSWER_MAX = 400;
const TOPIC_SELECTION_MAX = 600;
// The renderer already clips to 4000; the IPC payload is still input.
const SELECTION_MAX = 4000;
const QUESTION_MAX = 4000;
const DEFAULT_QUESTION = 'Bunu anlamadım — açıklar mısın?';
const NOTES_DIR = path.join(os.homedir(), '.claude', 'reading-room', 'notes');
const SESSION_WATCH_COALESCE_MS = 150;

const TUTOR_SYSTEM =
  'You are Rocky in Reading Room mode — a patient tutor sitting beside Alp (3rd-year Control & Automation ' +
  'Engineering student at İTÜ) while he reads another Claude Code session. Answer in the language he asks in ' +
  '(he mixes Turkish and English; keep technical terms in English). Student level, first principles, short ' +
  'paragraphs, one concrete example, no lists of more than 4 items. Never modify files or run commands. Ask one ' +
  'clarifying question only if the selection is truly ambiguous. When he says he understands, ask him to restate ' +
  'the idea in his own words in 2–3 sentences and correct him gently.';

let vaultPath = null;
let emit = () => {};

function configure(opts = {}) {
  if (opts.vaultPath) vaultPath = opts.vaultPath;
  if (typeof opts.onEvent === 'function') emit = opts.onEvent;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let current = null; // the open reader, see open()
const threads = new Map(); // threadId -> thread
const forks = new Map(); // mainSessionId -> { forkSessionId, forkTs }

function clip(s, max) {
  const str = String(s == null ? '' : s);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function oneLine(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
}

function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function listSessions() {
  const list = await sessions.listSessions();
  return list.map((s) => {
    const pid = Number(s.pid);
    const isOpen = current && current.pid === pid;
    let title = isOpen ? current.title : null;
    if (!title && s.sessionId && s.cwd) title = transcripts.peekTitle(transcripts.transcriptPath(s.cwd, s.sessionId));
    return {
      pid,
      sessionId: s.sessionId || null,
      name: s.sessionName || s.slug,
      cwd: s.cwd,
      project: s.name,
      status: isOpen ? current.status : s.activity || 'unknown',
      title: title || null,
    };
  });
}

function statusPayload(extra) {
  return {
    pid: current.pid,
    sessionId: current.sessionId,
    status: current.status,
    title: current.title,
    ...(extra || {}),
  };
}

function emitTurns(turns) {
  if (!current || !turns.length) return;
  emit('turns', { pid: current.pid, sessionId: current.sessionId, turns });
}

// Only ever reads `mine`, never `current`, after the await: close()/open()
// can run while openTail is in flight, and a tail that lost that race must be
// closed here or its fs.watch leaks for the life of the process.
async function attachTail(mine) {
  const reducer = transcripts.createReducer();
  mine.reducer = reducer;
  mine.file = transcripts.transcriptPath(mine.cwd, mine.sessionId);
  const tail = await transcripts.openTail({
    file: mine.file,
    reducer,
    onBatch: (turns, { titleChanged }) => {
      if (current !== mine || mine.reducer !== reducer) return; // a stale tail after a swap/close
      if (titleChanged && reducer.title) {
        mine.title = reducer.title;
        emit('status', statusPayload());
      }
      emitTurns(turns);
    },
    onError: () => {
      /* the transcript is Claude's file; if it goes away the next swap fixes it */
    },
  });
  if (current !== mine || mine.reducer !== reducer) {
    tail.close();
    return false;
  }
  mine.tail = tail;
  if (reducer.title) mine.title = reducer.title;
  if (!mine.title) mine.title = mine.name;
  return true;
}

// ~/.claude/sessions/<pid>.json changes in place: status busy↔idle as the
// session works, sessionId on /clear. One directory watch (there is no
// per-file event worth having here — the CLI rewrites the whole file) and a
// coalesced re-read of just our pid's file.
function watchSessionFile() {
  const mine = current;
  let timer = null;
  const onChange = (_ev, name) => {
    if (name && name !== `${mine.pid}.json`) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (current !== mine) return;
      refreshSessionInfo();
    }, SESSION_WATCH_COALESCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  try {
    mine.dirWatcher = fs.watch(transcripts.SESSIONS_DIR, { persistent: false }, onChange);
    mine.dirWatcher.on('error', () => {
      /* leave it — the reader keeps working off the last known session */
    });
  } catch {
    mine.dirWatcher = null;
  }
  mine.stopSessionWatch = () => {
    clearTimeout(timer);
    timer = null;
    if (mine.dirWatcher) {
      try {
        mine.dirWatcher.close();
      } catch {
        /* already closed */
      }
      mine.dirWatcher = null;
    }
  };
}

// Serialised per reader: a busy/idle flip that lands while a /clear swap is
// still attaching must wait, or two tails end up open on the same reader.
function refreshSessionInfo() {
  const mine = current;
  if (!mine) return Promise.resolve();
  mine.refreshChain = (mine.refreshChain || Promise.resolve())
    .then(() => (current === mine ? refreshSessionInfoNow(mine) : undefined))
    .catch(() => {
      /* the reader keeps working off the last known session */
    });
  return mine.refreshChain;
}

async function refreshSessionInfoNow(mine) {
  const info = transcripts.readSessionInfo(mine.pid);
  if (!info) {
    // The terminal went away (file deleted). Keep what we have on screen.
    if (mine.status !== 'unknown') {
      mine.status = 'unknown';
      emit('status', statusPayload());
    }
    return;
  }
  if (info.sessionId !== mine.sessionId) {
    // /clear — same terminal, new conversation. Swap files, keep threads.
    if (mine.tail) mine.tail.close();
    mine.tail = null;
    mine.sessionId = info.sessionId;
    mine.cwd = info.cwd || mine.cwd;
    mine.status = info.status;
    mine.name = info.name || mine.name;
    mine.title = null;
    if (!(await attachTail(mine))) return;
    emit('status', statusPayload({ swapped: true }));
    emitTurns(mine.reducer.turns.slice());
    return;
  }
  let changed = false;
  if (info.status !== mine.status) {
    mine.status = info.status;
    changed = true;
  }
  if (info.name && info.name !== mine.name) {
    mine.name = info.name;
    if (!mine.reducer.title) mine.title = info.name;
    changed = true;
  }
  if (changed) emit('status', statusPayload());
}

async function open(pid) {
  close();
  const n = Number(pid);
  const info = Number.isFinite(n) ? transcripts.readSessionInfo(n) : null;
  if (!info) return { ok: false, error: `No live Claude session for pid ${pid}.` };
  if (!info.cwd) return { ok: false, error: `Session ${info.sessionId} has no working directory recorded.` };

  current = {
    pid: n,
    sessionId: info.sessionId,
    cwd: info.cwd,
    name: info.name,
    project: sessions.projectNameForCwd(info.cwd),
    status: info.status,
    title: null,
    reducer: null,
    tail: null,
    file: null,
    dirWatcher: null,
    stopSessionWatch: null,
  };
  const mine = current;
  let attached = false;
  try {
    attached = await attachTail(mine);
  } catch (e) {
    if (current === mine) current = null;
    return { ok: false, error: `Could not read the transcript: ${e.message}` };
  }
  if (!attached || current !== mine) return { ok: false, error: 'Reader was closed while opening.' };
  watchSessionFile();
  return {
    ok: true,
    pid: mine.pid,
    sessionId: mine.sessionId,
    title: mine.title,
    status: mine.status,
    project: mine.project,
    cwd: mine.cwd,
    turns: mine.reducer.turns.slice(),
  };
}

// Everything that could wake the process goes away here: the file watch, the
// sessions-dir watch, and their coalescing timers. With no reader open this
// module holds nothing but the in-memory thread registry.
function close() {
  if (!current) return true;
  const c = current;
  current = null;
  if (c.tail) c.tail.close();
  if (c.stopSessionWatch) c.stopSessionWatch();
  return true;
}

// ---------------------------------------------------------------------------
// Side threads
// ---------------------------------------------------------------------------
function findTurn(uuid) {
  if (!current || !uuid) return { turn: null, index: -1 };
  const turns = current.reducer.turns;
  const index = turns.findIndex((t) => t.uuid === uuid);
  return { turn: index >= 0 ? turns[index] : null, index };
}

// The prompt that led to the selected turn: nearest real user turn above it.
function previousPrompt(index) {
  if (!current) return '';
  const turns = current.reducer.turns;
  for (let i = index - 1; i >= 0; i--) {
    if (turns[i].role === 'user' && !turns[i].queued) return turns[i].md;
  }
  return '';
}

// ≤ CTX_TURN_MAX chars of the containing turn, windowed around the selection
// so a passage deep in a long answer still arrives with its surroundings.
function turnWindow(md, selection) {
  const text = String(md || '');
  if (text.length <= CTX_TURN_MAX) return text;
  // The selection is rendered text; the turn is raw markdown, so a long
  // verbatim match usually fails on the first `**` or backtick. Try shorter
  // and shorter prefixes before giving up on locating it.
  let at = -1;
  for (const n of [200, 60, 24]) {
    const probe = selection ? selection.slice(0, n).trim() : '';
    if (probe.length < 8) break;
    at = text.indexOf(probe);
    if (at >= 0) break;
  }
  if (at < 0) return clip(text, CTX_TURN_MAX);
  let start = Math.max(0, at - Math.floor(CTX_TURN_MAX / 2));
  const end = Math.min(text.length, start + CTX_TURN_MAX);
  start = Math.max(0, end - CTX_TURN_MAX);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function firstMiniMessage({ selection, question, turnMd, prevPrompt }) {
  return (
    `Context — the terminal session "${current.title || current.name}" (project ${current.project}). ` +
    `Previous prompt by Alp:\n${clip(prevPrompt, CTX_PREV_PROMPT_MAX)}\n\n` +
    `The assistant turn he is reading:\n${turnWindow(turnMd, selection)}\n\n` +
    `He selected:\n"""${selection}"""\n\nAlp's question: ${question}`
  );
}

function firstForkMessage({ selection, question }) {
  return `He selected this passage from your earlier answer:\n"""${selection}"""\n\nAlp's question: ${question}`;
}

function followUpMessage({ question, selection }) {
  return selection ? `He now selected: """${selection}"""\n\n${question}` : question;
}

function sideThreadArgs() {
  // `--tools ""` is one argv element — an empty tool list. rocky.dispatch
  // pushes extraArgs one by one so the empty string survives.
  return ['--append-system-prompt', TUTOR_SYSTEM, '--setting-sources', 'user', '--tools', ''];
}

function ask(payload = {}) {
  const { pid, threadId, turnUuid, fullContext } = payload;
  const selection = clip(String(payload.selection || '').trim(), SELECTION_MAX);
  const question = clip(String(payload.question || '').trim(), QUESTION_MAX) || DEFAULT_QUESTION;

  if (!current || Number(pid) !== current.pid) {
    return { ok: false, error: 'Open the session in the Reading Room first.' };
  }
  if (!selection && !threadId) return { ok: false, error: 'Select a passage to ask about.' };

  let thread = threadId ? threads.get(threadId) : null;
  if (!thread) {
    thread = {
      threadId: crypto.randomUUID(),
      pid: current.pid,
      mainSessionId: current.sessionId,
      miniSessionId: null,
      forkSessionId: null,
      forkTurnUuid: null,
      selection,
      turnUuid: turnUuid || null,
      exchanges: [],
      lastSelection: null,
      notedCount: 0,
      jobId: null,
    };
    threads.set(thread.threadId, thread);
  }
  if (thread.jobId) return { ok: false, threadId: thread.threadId, error: 'Rocky is still answering in this thread.' };

  const selectionChanged = !!selection && selection !== thread.lastSelection;
  if (selection) thread.lastSelection = selection;
  const { turn, index } = findTurn(turnUuid || thread.turnUuid);

  const mode = fullContext ? 'fork' : 'mini';
  const extraArgs = sideThreadArgs();
  let prompt;
  let cwd = vaultPath || os.homedir();
  let pendingMiniId = null;
  let forking = false;

  if (mode === 'mini') {
    if (thread.miniSessionId) {
      prompt = followUpMessage({ question, selection: selectionChanged ? selection : null });
      extraArgs.push('--resume', thread.miniSessionId);
    } else {
      pendingMiniId = crypto.randomUUID();
      prompt = firstMiniMessage({
        selection,
        question,
        turnMd: turn ? turn.md : '',
        prevPrompt: turn ? previousPrompt(index) : '',
      });
      extraArgs.push('--session-id', pendingMiniId);
    }
  } else {
    // `--resume` finds the transcript through the cwd's project folder, so a
    // fork must run where the main session runs — not in the vault.
    cwd = current.cwd;
    const fork = forks.get(current.sessionId);
    const selectedTs = turn && turn.ts ? turn.ts : null;
    const forkStale = fork && selectedTs && fork.forkTs && selectedTs > fork.forkTs;
    if (fork && fork.forkSessionId && !forkStale) {
      extraArgs.push('--resume', fork.forkSessionId);
      prompt =
        thread.forkSessionId === fork.forkSessionId
          ? followUpMessage({ question, selection: selectionChanged ? selection : null })
          : firstForkMessage({ selection: selection || thread.selection, question });
    } else {
      forking = true;
      extraArgs.push('--resume', current.sessionId, '--fork-session');
      prompt = firstForkMessage({ selection: selection || thread.selection, question });
    }
  }

  const exchange = { q: question, a: '', mode, ts: new Date().toISOString() };
  const mainSessionId = current.sessionId;
  const newest = current.reducer.turns[current.reducer.turns.length - 1];
  const forkTs = newest && newest.ts ? newest.ts : new Date().toISOString();

  let job;
  try {
    job = rocky.dispatch({
      prompt,
      label: `Reading Room · ${firstLine(selection || thread.selection, 40)}`,
      cwd,
      extraArgs,
      model: 'sonnet',
      skipDedup: true,
      onSessionId: (sid) => {
        if (mode === 'mini') thread.miniSessionId = sid;
        else {
          thread.forkSessionId = sid;
          thread.forkTurnUuid = newest ? newest.uuid : null;
          if (forking) forks.set(mainSessionId, { forkSessionId: sid, forkTs });
        }
      },
      onDone: (done) => {
        thread.jobId = null;
        const text = String(done.output || '').trim();
        exchange.a = text || (done.state === 'done' ? '' : `(${done.state})`);
        exchange.state = done.state;
        // `--session-id X` only creates X when the run succeeds; a failed
        // first run would leave the next ask trying to `--resume` nothing.
        if (done.state !== 'done' && pendingMiniId && thread.miniSessionId === pendingMiniId) thread.miniSessionId = null;
      },
    });
  } catch (e) {
    return { ok: false, threadId: thread.threadId, mode, error: e.message };
  }

  if (pendingMiniId) thread.miniSessionId = pendingMiniId;
  thread.jobId = job.id;
  exchange.jobId = job.id;
  thread.exchanges.push(exchange);
  return { ok: true, threadId: thread.threadId, jobId: job.id, mode, args: job.args };
}

// ---------------------------------------------------------------------------
// Note-back: a file the vault's UserPromptSubmit hook picks up on Alp's next
// prompt in that terminal. Appends only the exchanges not yet noted.
// ---------------------------------------------------------------------------
function note({ threadId } = {}) {
  const thread = threads.get(threadId);
  if (!thread) return { ok: false, error: 'Unknown thread.' };
  const answered = thread.exchanges.filter((e) => e.a);
  const fresh = answered.slice(thread.notedCount);
  // After /clear the same terminal is on a new sessionId; the hook keys on
  // whatever the terminal is on *now*, so follow the open reader if it's ours.
  const sid = current && current.pid === thread.pid && current.sessionId ? current.sessionId : thread.mainSessionId;
  const file = path.join(NOTES_DIR, `${sid}.md`);
  if (!fresh.length) return { ok: true, file, appended: 0 };
  const lines = [
    `### ${hhmm()} · Reading Room`,
    `Selection: "${oneLine(clip(thread.selection, NOTE_SELECTION_MAX))}"`,
    ...fresh.map((e) => `Alp asked: ${oneLine(e.q)}  →  Rocky: ${clip(oneLine(e.a), NOTE_ANSWER_MAX)}`),
  ];
  try {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.appendFileSync(file, lines.join('\n') + '\n\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `Could not write the note: ${e.message}` };
  }
  thread.notedCount = answered.length;
  return { ok: true, file, appended: fresh.length };
}

// ---------------------------------------------------------------------------
// Learning/Topics
// ---------------------------------------------------------------------------
function topicsDir() {
  return path.join(vaultPath || '', 'Learning', 'Topics');
}

function listTopics() {
  const dir = topicsDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      } catch {
        /* skip */
      }
      return { file: path.posix.join('Learning', 'Topics', f), title: f.replace(/\.md$/, ''), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ file, title }) => ({ file, title }));
}

// Only ever writes to an existing note under Learning/Topics — the renderer
// hands back a `file` it got from listTopics(), but that's still input.
function resolveTopicFile(topicFile) {
  const dir = path.resolve(topicsDir());
  const resolved = path.resolve(vaultPath || '', String(topicFile || ''));
  if (!resolved.startsWith(dir + path.sep) || !resolved.endsWith('.md')) {
    throw new Error('Refusing to write outside Learning/Topics.');
  }
  if (!fs.existsSync(resolved)) throw new Error('That topic note does not exist.');
  return resolved;
}

function saveTopic({ threadId, topicFile } = {}) {
  const thread = threads.get(threadId);
  if (!thread) return { ok: false, error: 'Unknown thread.' };
  const answered = thread.exchanges.filter((e) => e.a);
  if (!answered.length) return { ok: false, error: 'Nothing answered yet in this thread.' };
  let file;
  try {
    file = resolveTopicFile(topicFile);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)} ${hhmm(now)}`;
  const from = current && current.pid === thread.pid ? current.title || current.name : thread.mainSessionId.slice(0, 8);
  const block = [
    `### ${stamp} — from terminal "${from}"`,
    ...clip(thread.selection, TOPIC_SELECTION_MAX)
      .split('\n')
      .map((l) => `> ${l}`),
    '',
    ...answered.flatMap((e) => [`**Q:** ${e.q}`, '', `**Rocky:** ${e.a}`, '']),
  ].join('\n');

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, error: `Could not read the note: ${e.message}` };
  }
  const heading = '## Reading Room';
  const lines = content.split('\n');
  let hi = lines.findIndex((l) => l.trim() === heading);
  if (hi < 0) {
    if (content.length && !content.endsWith('\n')) content += '\n';
    content += `\n${heading}\n\n${block}\n`;
  } else {
    // End of the section = the next `## ` heading, or end of file.
    let end = lines.length;
    for (let i = hi + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        end = i;
        break;
      }
    }
    const before = lines.slice(0, end).join('\n').replace(/\s+$/, '');
    const after = lines.slice(end).join('\n');
    content = `${before}\n\n${block}\n${after ? '\n' + after : ''}`;
  }
  try {
    fs.writeFileSync(file, content, 'utf8');
  } catch (e) {
    return { ok: false, error: `Could not write the note: ${e.message}` };
  }
  return { ok: true, file: path.relative(vaultPath || '', file) };
}

module.exports = {
  configure,
  listSessions,
  open,
  close,
  ask,
  note,
  saveTopic,
  listTopics,
  // exported for tests
  TUTOR_SYSTEM,
  NOTES_DIR,
  getThread: (id) => threads.get(id) || null,
};
