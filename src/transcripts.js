// Claude Code transcript reader — turns the append-only JSONL that every
// interactive `claude` session writes under ~/.claude/projects/<cwd-slug>/ into
// a flat list of "turns" the Reading Room can render as prose, and keeps that
// list current by tailing the file.
//
// Electron-free like sessions.js and rocky.js; reader.js wires it up and
// test/transcripts.test.js runs the reducer over real transcripts.
//
// Efficiency rules (this runs on battery, next to four live terminals):
//   * Nothing polls. One fs.watch on the transcript file — kqueue fires
//     'change' on append — coalesced to a 150 ms tick, then a read from the
//     byte offset we stopped at last time. A partial trailing line is carried
//     over to the next read, never re-parsed.
//   * Most lines in a transcript are not conversation (hook payloads, file
//     snapshots, attachments, permission-mode noise…). The first few hundred
//     bytes are sniffed with a regex and only the five record types we render
//     ever reach JSON.parse.
//   * Tool results are parsed (the type is only knowable after the parse) but
//     we keep a ≤120-char peek and drop the body on the floor.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');
const { summarizeToolInput, firstLine, textOfToolResult } = require('./rocky');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');

// Server-side memory per open reader. The frontend renders 40 and pages
// backwards through the rest; older than 200 turns you scroll the terminal.
const MAX_TURNS = 200;
const PEEK_MAX = 120;
// How much of a line to look at before deciding whether to parse it at all.
// User/system/title/queue records put their top-level `"type"` first. Real
// assistant records do NOT — they serialise `message` (thinking blocks,
// kilobytes of signature, the whole text) *before* `"type":"assistant"`, so
// the only early marker is `"role":"assistant"` inside the message header,
// ~200 bytes in. Sniffing for the type alone silently dropped every
// assistant turn; this is verified against real transcripts by the test.
const SNIFF_BYTES = 400;
const WANTED_TYPE = /"type":"(user|ai-title|queue-operation|system)"|"role":"(user|assistant)"/;
const WATCH_COALESCE_MS = 150;
const READ_CHUNK = 1 << 20;
// tool_use ids waiting for their tool_result. Bounded so a transcript full of
// results that never came (killed jobs) can't grow this forever.
const MAX_PENDING_TOOLS = 500;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Claude Code names the per-project transcript folder by replacing every
// character outside [A-Za-z0-9] with '-', *without* collapsing runs:
// /private/tmp/claude-501/-Users-x → -private-tmp-claude-501--Users-x.
function projectSlug(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function transcriptPath(cwd, sessionId) {
  return path.join(PROJECTS_DIR, projectSlug(cwd), `${sessionId}.jsonl`);
}

// ~/.claude/sessions/<pid>.json is written by the interactive CLI itself and
// carries the one thing `ps`/`lsof` can't give us: which sessionId this pid is
// currently on. It changes in place on /clear, and its `status` flips between
// busy/idle as the session works — so it doubles as the live status source.
function readSessionInfo(pid) {
  try {
    const raw = fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || !d.sessionId) return null;
    return {
      pid: Number(pid),
      sessionId: String(d.sessionId),
      cwd: d.cwd ? String(d.cwd) : null,
      name: d.name ? String(d.name) : null,
      status: d.status === 'busy' || d.status === 'idle' ? d.status : 'unknown',
      updatedAt: Number(d.statusUpdatedAt || d.updatedAt || 0) || 0,
      kind: d.kind || null,
    };
  } catch {
    return null;
  }
}

// The session title (`ai-title` record) lives somewhere in the transcript,
// re-emitted whenever Claude renames it. For a list of sessions I don't want
// to reduce every file, so read the last 64KB and take the last one seen.
function peekTitle(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const re = /"aiTitle":"((?:[^"\\]|\\.)*)"/g;
    let m;
    let last = null;
    while ((m = re.exec(text))) last = m[1];
    return last ? JSON.parse(`"${last}"`) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Reducer: JSONL lines → turns
//
// Turn shape (the contract with the renderer):
//   { uuid, role: 'user'|'assistant'|'tools'|'error', ts, md, tools, queued? }
// Assistant records arrive one per content block (thinking / text / tool_use
// each on its own line) sharing message.id, so a turn is usually *updated*
// several times before it's complete. The renderer upserts by uuid.
// ---------------------------------------------------------------------------
let uuidSeq = 0;
function fallbackUuid() {
  uuidSeq += 1;
  return `t${Date.now().toString(36)}${uuidSeq}`;
}

// A user record that is not a prompt Alp typed: slash-command echoes, the
// caveat that precedes local command output, or a record that was nothing
// but injected <system-reminder> blocks.
function cleanUserText(s) {
  let t = String(s == null ? '' : s);
  const lead = t.trimStart();
  // A slash command Alp typed is stored as
  // <command-message>save</command-message>\n<command-name>/save</command-name>\n<command-args>…</command-args>
  // (verified on 35 records across the corpus, 2026-09-05). Show what he
  // actually typed — "/save …" — not the tags.
  if (lead.startsWith('<command-message>') || lead.startsWith('<command-name>')) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(lead);
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(lead);
    if (!name) return '';
    return `${name[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`.trim();
  }
  if (lead.startsWith('<local-command-')) return '';
  // Ctrl-C leaves "[Request interrupted by user]" / "[… for tool use]" as a
  // user record. Alp didn't write it; the next real prompt tells the story.
  if (/^\[Request interrupted by user[^\]]*\]\s*$/.test(lead)) return '';
  // Harness-injected turns (background task notifications, hook output) are
  // stored as user records too, but Alp never typed them.
  if (lead.startsWith('<task-notification>') || lead.startsWith('[SYSTEM NOTIFICATION')) return '';
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '');
  return t.trim();
}

function createReducer() {
  const turns = [];
  const dirty = new Map(); // uuid -> turn touched since the last drain()
  let title = null;
  let titleChanged = false;
  let openMsg = null; // { id, turn } — assistant message being assembled
  let openTools = null; // 'tools' turn still accepting chips
  const pendingTools = new Map(); // tool_use_id -> { chip, turn }
  const ghosts = []; // queued prompts (queue-operation enqueue) awaiting the real record

  function push(turn) {
    turns.push(turn);
    dirty.set(turn.uuid, turn);
    if (turns.length > MAX_TURNS) {
      for (const gone of turns.splice(0, turns.length - MAX_TURNS)) dirty.delete(gone.uuid);
    }
  }

  function touch(turn) {
    dirty.set(turn.uuid, turn);
  }

  // A real user prompt ends whatever the assistant was assembling; the next
  // assistant record starts fresh turns.
  function closeGroups() {
    openMsg = null;
    openTools = null;
  }

  function remember(toolUseId, chip, turn) {
    pendingTools.set(toolUseId, { chip, turn });
    if (pendingTools.size > MAX_PENDING_TOOLS) {
      pendingTools.delete(pendingTools.keys().next().value);
    }
  }

  function onToolResult(block) {
    const entry = block.tool_use_id ? pendingTools.get(block.tool_use_id) : null;
    if (!entry) return;
    pendingTools.delete(block.tool_use_id);
    entry.chip.peek = firstLine(textOfToolResult(block.content), PEEK_MAX);
    entry.chip.isError = block.is_error === true;
    touch(entry.turn);
  }

  function onAssistant(rec) {
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : {};
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    const ts = rec.timestamp || null;

    if (rec.isApiErrorMessage === true) {
      const text = blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => String(b.text || ''))
        .join('\n')
        .trim();
      closeGroups();
      push({ uuid: rec.uuid || fallbackUuid(), role: 'error', ts, md: text || 'API error', tools: [] });
      return;
    }

    const msgId = msg.id || rec.uuid || fallbackUuid();
    if (!openMsg || openMsg.id !== msgId) openMsg = { id: msgId, turn: null };

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        const text = String(b.text == null ? '' : b.text);
        if (!text.trim()) continue;
        if (openMsg.turn) {
          openMsg.turn.md += (openMsg.turn.md ? '\n\n' : '') + text;
          touch(openMsg.turn);
        } else {
          openMsg.turn = { uuid: rec.uuid || fallbackUuid(), role: 'assistant', ts, md: text, tools: [], msgId };
          push(openMsg.turn);
        }
        // Prose after a run of tools = the next tools go in a fresh row below it.
        openTools = null;
      } else if (b.type === 'tool_use') {
        const chip = { name: String(b.name || 'tool'), arg: summarizeToolInput(b.input), peek: '', isError: false };
        if (!openTools) {
          openTools = { uuid: `${rec.uuid || fallbackUuid()}:tools`, role: 'tools', ts, md: '', tools: [] };
          push(openTools);
        }
        openTools.tools.push(chip);
        touch(openTools);
        if (b.id) remember(String(b.id), chip, openTools);
      }
      // thinking / redacted_thinking / anything new → dropped on purpose
    }
  }

  function onUser(rec) {
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : {};
    const c = msg.content;
    const ts = rec.timestamp || null;
    let text = '';
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      const parts = [];
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') onToolResult(b);
        else if (b.type === 'text') parts.push(String(b.text == null ? '' : b.text));
        else if (b.type === 'image') parts.push('[image]');
        else if (b.type === 'document') parts.push('[document]');
      }
      text = parts.join('\n');
    }
    text = cleanUserText(text);
    if (!text) return; // tool results only, or command noise

    closeGroups();
    // A prompt Alp queued while Claude was busy already has a ghost turn (see
    // queue-operation below). The real record replaces it in place so the
    // list doesn't show the same prompt twice.
    let gi = ghosts.findIndex((g) => g.md.trim() === text);
    if (gi < 0) gi = ghosts.findIndex((g) => g.expecting);
    if (gi >= 0) {
      const g = ghosts.splice(gi, 1)[0];
      g.md = text;
      g.ts = ts || g.ts;
      delete g.queued;
      delete g.expecting;
      touch(g);
      return;
    }
    push({ uuid: rec.uuid || fallbackUuid(), role: 'user', ts, md: text, tools: [] });
  }

  function onQueue(rec) {
    if (rec.operation === 'enqueue') {
      const text = cleanUserText(rec.content);
      if (!text) return;
      const g = { uuid: `q:${rec.timestamp || fallbackUuid()}`, role: 'user', ts: rec.timestamp || null, md: text, tools: [], queued: true };
      ghosts.push(g);
      push(g);
    } else if (rec.operation === 'dequeue') {
      // The next real user record is this ghost, whatever its final text
      // (attachments can change it) — flag it so onUser can claim it.
      const g = ghosts.find((x) => !x.expecting);
      if (g) g.expecting = true;
    }
  }

  function handle(rec) {
    switch (rec.type) {
      case 'ai-title':
        if (typeof rec.aiTitle === 'string' && rec.aiTitle && rec.aiTitle !== title) {
          title = rec.aiTitle;
          titleChanged = true;
        }
        return;
      case 'queue-operation':
        return onQueue(rec);
      case 'system':
        return; // turn_duration, away_summary… nothing to read (v1)
      case 'assistant':
        if (rec.isSidechain === true || rec.isMeta === true) return;
        return onAssistant(rec);
      case 'user':
        if (rec.isSidechain === true || rec.isMeta === true) return;
        return onUser(rec);
      default:
        return;
    }
  }

  function feed(line) {
    if (!line) return;
    const head = line.length > SNIFF_BYTES ? line.slice(0, SNIFF_BYTES) : line;
    if (!WANTED_TYPE.test(head)) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return; // a torn line at a crash boundary — not ours to fix
    }
    if (!rec || typeof rec !== 'object') return;
    try {
      handle(rec);
    } catch {
      /* unknown shape — skip the record, never the file */
    }
  }

  // Turns touched since the last drain, oldest first. Objects are the live
  // ones (a later feed() may mutate them again) — fine for IPC, which clones.
  function drain() {
    const out = [...dirty.values()];
    dirty.clear();
    return out;
  }

  function takeTitleChanged() {
    const v = titleChanged;
    titleChanged = false;
    return v;
  }

  return {
    feed,
    drain,
    takeTitleChanged,
    get turns() {
      return turns;
    },
    get title() {
      return title;
    },
  };
}

// ---------------------------------------------------------------------------
// Tail: keep a reducer fed from a growing file
// ---------------------------------------------------------------------------
// Resolves after the initial load (the caller reads reducer.turns for the
// opening render — nothing from the initial pass is reported via onBatch).
// From then on every append is reduced and the touched turns are handed to
// onBatch(turns, { titleChanged }). If the file doesn't exist yet (a session
// right after /clear has no transcript until the first prompt) the directory
// is watched until it appears.
async function openTail({ file, reducer, onBatch, onError }) {
  let offset = 0;
  let carry = '';
  let decoder = new StringDecoder('utf8');
  let watcher = null;
  let dirWatcher = null;
  let timer = null;
  let reading = false;
  let again = false;
  let closed = false;
  let initial = true;

  function feedChunk(text) {
    carry += text;
    const parts = carry.split('\n');
    carry = parts.pop();
    for (const line of parts) if (line.length > 1) reducer.feed(line);
  }

  async function readNew() {
    if (closed) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      let st = null;
      try {
        st = await fsp.stat(file);
      } catch {
        st = null; // not written yet
      }
      if (st) {
        if (st.size < offset) {
          // Truncated/replaced — the honest thing is to start over.
          offset = 0;
          carry = '';
          decoder = new StringDecoder('utf8');
        }
        if (st.size > offset) {
          const fh = await fsp.open(file, 'r');
          try {
            const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, st.size - offset));
            while (offset < st.size && !closed) {
              const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
              if (!bytesRead) break;
              offset += bytesRead;
              feedChunk(decoder.write(buf.subarray(0, bytesRead)));
            }
          } finally {
            await fh.close();
          }
        }
        if (!initial) {
          const batch = reducer.drain();
          const titleChanged = reducer.takeTitleChanged();
          if ((batch.length || titleChanged) && typeof onBatch === 'function') onBatch(batch, { titleChanged });
        }
      }
    } catch (e) {
      if (typeof onError === 'function') onError(e);
    }
    reading = false;
    if (again && !closed) {
      again = false;
      readNew();
    }
  }

  function schedule() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      readNew();
    }, WATCH_COALESCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // FSEvents (what fs.watch is on macOS) merges writes to one file that land
  // within its latency window, and a merged event whose id predates the
  // stream's start is dropped — so an append that follows a big write we
  // just read (the initial load of a live transcript) can go unreported
  // until the *next* append. Measured: first append after opening a 5 MB
  // transcript delivered 1.7 s late, riding on the second append. Two
  // one-off catch-up reads (no polling) close that window.
  let catchUp = [];
  function armCatchUp() {
    for (const t of catchUp) clearTimeout(t);
    catchUp = [1000, 3000].map((ms) => {
      const t = setTimeout(() => readNew(), ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    });
  }

  function watchFile() {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(file, { persistent: false }, schedule);
      armCatchUp();
      watcher.on('error', () => {
        closeWatcher();
        watchDir();
      });
      if (dirWatcher) {
        dirWatcher.close();
        dirWatcher = null;
      }
    } catch {
      watchDir();
    }
  }

  function closeWatcher() {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    }
  }

  // Until the transcript exists, watch its folder for it to be created.
  function watchDir() {
    if (dirWatcher || closed) return;
    const dir = path.dirname(file);
    const base = path.basename(file);
    try {
      dirWatcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (name && name !== base) return;
        if (fs.existsSync(file)) {
          watchFile();
          schedule();
        }
      });
      dirWatcher.on('error', () => {
        if (typeof onError === 'function') onError(new Error(`Lost watch on ${dir}`));
      });
    } catch (e) {
      if (typeof onError === 'function') onError(e);
    }
  }

  await readNew();
  reducer.drain();
  reducer.takeTitleChanged();
  initial = false;
  if (fs.existsSync(file)) watchFile();
  else watchDir();

  return {
    file,
    get offset() {
      return offset;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      for (const t of catchUp) clearTimeout(t);
      catchUp = [];
      closeWatcher();
      if (dirWatcher) {
        try {
          dirWatcher.close();
        } catch {
          /* already closed */
        }
        dirWatcher = null;
      }
    },
  };
}

module.exports = {
  PROJECTS_DIR,
  SESSIONS_DIR,
  MAX_TURNS,
  projectSlug,
  transcriptPath,
  readSessionInfo,
  peekTitle,
  cleanUserText,
  createReducer,
  openTail,
};
