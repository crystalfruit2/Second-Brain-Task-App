// Rocky job runner — dispatches work to the `claude` CLI headlessly and streams
// its output back to whoever is listening (the Mission Control window).
//
// Deliberately Electron-free, same as sessions.js: main.js injects where the
// history file lives and how to emit events, so this module can be exercised
// from a plain node script during testing.
//
// Efficiency rule: nothing in here is polled. A job is a child process; we react
// to its 'data'/'close' events and push. When no job is running this module
// costs exactly zero CPU.
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Cap what we keep in memory per job. Claude can emit a lot of tool output on a
// long job and this is a monitor, not a log archive — the tail is what matters.
const MAX_OUTPUT_CHARS = 60_000;
// What actually gets written to disk per job (history is for "what did I ask it
// to do last week", not for re-reading a full transcript).
const MAX_PERSISTED_CHARS = 4_000;
const MAX_HISTORY = 50;
// Streamed text arrives one token at a time. Sending an IPC message per token
// (and letting the renderer append a DOM node + read scrollHeight per token) is
// the difference between "live monitor" and "melts the laptop", so chunks are
// batched behind this timer instead.
const OUTPUT_FLUSH_MS = 100;
// How long a killed job gets to honour SIGTERM before the group gets SIGKILL.
const KILL_GRACE_MS = 2_000;
// Stdio can stay open past the child's own exit if a grandchild inherited it;
// don't hold a job "running" forever waiting for a 'close' that isn't coming.
const CLOSE_GRACE_MS = 1_500;
// One person, one laptop: five concurrent agents is already more than I can
// read, and each one is a full Claude session.
const MAX_CONCURRENT_JOBS = 5;

let historyFile = null;
let emit = () => {};

function configure(opts = {}) {
  if (opts.historyFile) historyFile = opts.historyFile;
  if (typeof opts.onEvent === 'function') emit = opts.onEvent;
}

// ---------------------------------------------------------------------------
// Finding the `claude` binary
//
// The classic Electron gotcha: a GUI app launched from Finder/Dock inherits a
// bare `/usr/bin:/bin:/usr/sbin:/sbin` PATH, not the one from ~/.zshrc — so
// `spawn('claude')` works when I launch via `npm start` from a terminal and
// mysteriously fails when I launch the packaged .app. So: check PATH, then the
// handful of places it's actually installed, and only as a last resort pay for
// a login shell to ask.
// ---------------------------------------------------------------------------
const KNOWN_BIN_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  path.join(os.homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function fromLoginShell() {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-l', '-c', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = out.trim().split('\n').pop();
    return found && isExecutable(found) ? found : null;
  } catch {
    return null;
  }
}

// Only a *successful* resolve is cached. Caching a failure would mean that if
// the app happened to start before Claude Code was installed (or before the
// login shell could answer), every dispatch for the rest of the app's life
// would fail with "couldn't find the binary" even after I'd fixed it.
let claudeBinCache = null;
function resolveClaudeBin() {
  if (claudeBinCache && isExecutable(claudeBinCache)) return claudeBinCache;
  claudeBinCache = null;

  const explicit = process.env.ROCKY_CLAUDE_BIN;
  if (explicit && isExecutable(explicit)) return (claudeBinCache = explicit);

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (isExecutable(candidate)) return (claudeBinCache = candidate);
  }
  for (const candidate of KNOWN_BIN_PATHS) {
    if (isExecutable(candidate)) return (claudeBinCache = candidate);
  }
  const fromShell = fromLoginShell();
  return fromShell ? (claudeBinCache = fromShell) : null;
}

// ---------------------------------------------------------------------------
// stream-json → readable text
//
// `claude -p --output-format stream-json --include-partial-messages --verbose`
// emits one JSON object per line. Most of them are noise for a monitor (hook
// payloads alone can be 10KB each), so this keeps only the four things I'd
// actually want to watch: streamed assistant text, which tool it just reached
// for, a one-line peek at what that tool returned, and errors.
// ---------------------------------------------------------------------------
function firstLine(value, max = 120) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.command ||
    input.file_path ||
    input.pattern ||
    input.path ||
    input.query ||
    input.url ||
    input.description ||
    input.prompt ||
    '';
  return firstLine(pick, 76);
}

function textOfToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && c.type === 'text' ? c.text : '')).join(' ');
  }
  return '';
}

// Returns the text to append to the job log for one parsed stream-json object.
function renderStreamObject(obj) {
  if (!obj || typeof obj !== 'object') return '';

  // Token-level text as it arrives — this is what makes the card feel live.
  if (obj.type === 'stream_event') {
    const ev = obj.event || {};
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      return ev.delta.text || '';
    }
    return '';
  }

  // Whole assistant messages arrive too, one per content block. Their text was
  // already streamed above, so only tool calls are new information here —
  // and by this point the tool input is fully parsed, unlike the deltas.
  if (obj.type === 'assistant') {
    const blocks = (obj.message && obj.message.content) || [];
    let out = '';
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      const arg = summarizeToolInput(b.input);
      out += `\n⏺ ${b.name}${arg ? `(${arg})` : ''}\n`;
    }
    return out;
  }

  if (obj.type === 'user') {
    const blocks = (obj.message && obj.message.content) || [];
    let out = '';
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const body = firstLine(textOfToolResult(b.content));
      out += `  ↳ ${b.is_error ? 'error: ' : ''}${body || '(no output)'}\n`;
    }
    return out;
  }

  if (obj.type === 'result' && obj.is_error) {
    return `\n! ${firstLine(obj.result || obj.subtype || 'failed', 300)}\n`;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> internal job record (holds the child process)
let history = null; // lazily loaded array of finished jobs, newest first
let seq = 0;

function newId() {
  seq += 1;
  return `j${Date.now().toString(36)}${seq}`;
}

function loadHistory() {
  if (history) return history;
  history = [];
  if (!historyFile) return history;
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    // Anything that isn't a job-shaped object is dropped rather than trusted:
    // one `null` in this file used to throw out of listJobs() on every call,
    // which bricked the whole jobs panel permanently.
    if (Array.isArray(parsed)) {
      history = parsed.filter((j) => j && typeof j === 'object' && j.id).slice(0, MAX_HISTORY);
    }
  } catch {
    /* no history yet, or it got corrupted — start clean rather than crash */
  }
  return history;
}

function persist(job) {
  if (!historyFile) return;
  const list = loadHistory();
  list.unshift({ ...publicJob(job), output: tail(job.output, MAX_PERSISTED_CHARS), live: false });
  history = list.slice(0, MAX_HISTORY);
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
  } catch {
    /* non-fatal — losing history is not worth failing a job over */
  }
}

function tail(s, max) {
  const str = String(s || '');
  return str.length > max ? '…' + str.slice(str.length - max) : str;
}

function publicJob(job) {
  return {
    id: job.id,
    prompt: job.prompt,
    label: job.label,
    cwd: job.cwd,
    mode: job.mode,
    state: job.state,
    // SIGTERM has been sent but the child hasn't actually exited yet — the card
    // says "stopping…" rather than lying about it being dead.
    stopping: job.state === 'running' && !!job.killRequested,
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
    exitCode: job.exitCode === undefined ? null : job.exitCode,
    output: job.output || '',
    live: true,
  };
}

function unrefTimer(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

// Push a chunk into the job's rolling tail and queue it for the renderer.
//
// Two things this deliberately does NOT do per chunk: rebuild the 60KB tail
// (it only trims once the buffer has grown to twice the cap, so trimming is
// amortised instead of quadratic), and emit an IPC message (see flushOutput).
function append(job, chunk) {
  if (!chunk) return;
  job.output += chunk;
  if (job.output.length > MAX_OUTPUT_CHARS * 2) job.output = tail(job.output, MAX_OUTPUT_CHARS);

  job.pending += chunk;
  if (job.pending.length > MAX_OUTPUT_CHARS) job.pending = tail(job.pending, MAX_OUTPUT_CHARS);
  if (!job.flushTimer) {
    job.flushTimer = unrefTimer(setTimeout(() => flushOutput(job), OUTPUT_FLUSH_MS));
  }
}

// One IPC message per ~100ms of streaming instead of one per token.
function flushOutput(job) {
  if (job.flushTimer) {
    clearTimeout(job.flushTimer);
    job.flushTimer = null;
  }
  if (!job.pending) return;
  const chunk = job.pending;
  job.pending = '';
  emit('output', { id: job.id, chunk });
}

// One shared line-buffer per stream, since a 'data' chunk can split a JSON line
// down the middle (and routinely does — some of these lines are kilobytes).
function makeLineReader(onLine) {
  let buf = '';
  return {
    push(text) {
      buf += text;
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) if (line.trim()) onLine(line);
      // Newline-free output (a binary blob, a progress bar redrawing with \r,
      // a runaway one-line dump) would otherwise grow this buffer without any
      // bound at all. Past the cap, treat what we have as a line and move on.
      if (buf.length > MAX_OUTPUT_CHARS) {
        const forced = buf;
        buf = '';
        if (forced.trim()) onLine(forced);
      }
    },
    flush() {
      if (buf.trim()) onLine(buf);
      buf = '';
    },
  };
}

// Dispatch a prompt to `claude -p` in `cwd`. Returns the job snapshot straight
// away; everything after that arrives through emit('update'|'output', …).
function runningJobs() {
  return [...jobs.values()].filter((j) => j.state === 'running');
}

function dispatch({ prompt, label, cwd }) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Nothing to dispatch — the prompt is empty.');

  // Double-clicking "Start Day" used to launch two autonomous agents rewriting
  // the same daily note at the same time. Same prompt (or same quick-action
  // label) already in flight => refuse, loudly, rather than dedupe silently.
  const running = runningJobs();
  const dup = running.find((j) => j.prompt === text || (label && j.label === label));
  if (dup) {
    throw new Error(`"${label || firstLine(text, 48)}" is already running — let it finish first.`);
  }
  if (running.length >= MAX_CONCURRENT_JOBS) {
    throw new Error(
      `${running.length} jobs already running (max ${MAX_CONCURRENT_JOBS}). Stop one before dispatching another.`
    );
  }

  const bin = resolveClaudeBin();
  if (!bin) {
    throw new Error(
      "Couldn't find the `claude` binary. Install Claude Code, or set ROCKY_CLAUDE_BIN to its full path."
    );
  }

  const job = {
    id: newId(),
    prompt: text,
    label: label || null,
    cwd: cwd || os.homedir(),
    mode: 'headless',
    state: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: undefined,
    output: '',
    pending: '', // buffered output waiting for the next flush tick
    flushTimer: null,
    killTimer: null,
    killRequested: false,
    child: null,
  };

  const args = [
    '-p',
    text,
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];

  const child = spawn(bin, args, {
    cwd: job.cwd,
    // Force a sane PATH for anything the agent shells out to, since the app's
    // own PATH may be the stripped-down GUI one (see resolveClaudeBin above).
    env: {
      ...process.env,
      PATH: [path.dirname(bin), process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin']
        .filter(Boolean)
        .join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so killing the job kills everything the agent spawned
    // (a `sh -c` here, an npm test there) and not just the `claude` process
    // sitting at the top of that tree. See killJob().
    detached: true,
  });
  job.child = child;
  jobs.set(job.id, job);

  const reader = makeLineReader((line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      append(job, line + '\n'); // not JSON — show it verbatim rather than hide it
      return;
    }
    append(job, renderStreamObject(obj));
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => reader.push(d));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => append(job, `\n! ${String(d).trim()}\n`));

  // 'close' (stdio drained + process gone) is the honest end of a job, but a
  // grandchild holding the inherited pipe open can delay it past the child's
  // own exit — so 'exit' arms a short fallback instead of being trusted alone.
  let ended = false;
  const settle = (code) => {
    if (ended) return;
    ended = true;
    reader.flush();
    if (job.state !== 'running') return; // already finished via error
    if (job.killRequested) finish(job, code, 'killed');
    else finish(job, code, code === 0 ? 'done' : 'failed');
  };

  child.on('error', (err) => {
    append(job, `\n! ${err.message}\n`);
    ended = true;
    if (job.state === 'running') finish(job, null, 'failed');
  });

  child.on('exit', (code) => {
    unrefTimer(setTimeout(() => settle(code), CLOSE_GRACE_MS));
  });
  child.on('close', (code) => settle(code));

  emit('update', publicJob(job));
  return publicJob(job);
}

function finish(job, code, state) {
  job.state = state;
  job.exitCode = code;
  job.endedAt = Date.now();
  job.child = null;
  clearTimeout(job.killTimer);
  job.killTimer = null;
  flushOutput(job); // last chunk goes out before the state change lands
  persist(job);
  emit('update', publicJob(job));
  // A finished job lives in the history file from here on. Keeping it in the
  // Map as well meant every job of the session pinned its 60KB tail in memory
  // for as long as the app stayed open.
  jobs.delete(job.id);
}

// Signal the child's whole process group. spawn() used `detached: true`, so the
// child leads a group of its own and a negative pid reaches everything it
// started; if that fails (no group, already reaped) fall back to the child.
function signalGroup(job, signal) {
  const child = job.child;
  if (!child || child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch (e) {
    if (e && e.code === 'ESRCH') return; // already gone
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

// Ask nicely, then insist. The job stays `running` until the process actually
// exits — marking it "killed" the moment SIGTERM was *sent* was a lie whenever
// the child ignored the signal.
function killJob(id) {
  const job = jobs.get(id);
  if (!job || job.state !== 'running' || !job.child) return false;
  if (!job.killRequested) {
    job.killRequested = true;
    signalGroup(job, 'SIGTERM');
    job.killTimer = unrefTimer(
      setTimeout(() => {
        if (job.state === 'running') signalGroup(job, 'SIGKILL');
      }, KILL_GRACE_MS)
    );
    emit('update', publicJob(job));
  } else {
    // Second click on Stop = don't wait out the grace period.
    signalGroup(job, 'SIGKILL');
  }
  return true;
}

// Live jobs first (newest first), then whatever's left of the persisted history
// (which is where every *finished* job lives now — see finish()).
function listJobs() {
  const live = [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt);
  const liveIds = new Set(live.map((j) => j.id));
  const past = loadHistory().filter((j) => !liveIds.has(j.id));
  return [...live, ...past].slice(0, MAX_HISTORY);
}

// Called from before-quit: SIGTERM every group, then SIGKILL synchronously a
// moment later, because the app is on its way out and won't be around to run a
// timer. Without the group kill, an agent's grandchildren outlived the app.
function killAll() {
  const live = runningJobs();
  for (const job of live) {
    job.killRequested = true;
    signalGroup(job, 'SIGTERM');
  }
  if (!live.length) return;
  // A blocking (not CPU-burning) grace period — before-quit is synchronous, so
  // there's no event loop left to schedule the follow-up on.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  for (const job of live) signalGroup(job, 'SIGKILL');
}

// ---------------------------------------------------------------------------
// "Open in Terminal" mode — for a big job I want to watch and steer rather than
// read after the fact. Same prompt, same cwd, but an interactive session in
// Terminal.app instead of a captured child process.
// ---------------------------------------------------------------------------
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function osaQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function openInTerminal({ prompt, cwd }) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Nothing to open — the prompt is empty.');
  if (process.platform !== 'darwin') throw new Error('Terminal hand-off is macOS-only.');
  const bin = resolveClaudeBin();
  if (!bin) throw new Error("Couldn't find the `claude` binary.");

  const command = `cd ${shellQuote(cwd || os.homedir())} && ${shellQuote(bin)} ${shellQuote(text)}`;
  const script = `tell application "Terminal"\nactivate\ndo script ${osaQuote(command)}\nend tell`;

  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 10_000 }, (err) => {
      if (err) reject(new Error(`Could not open Terminal: ${err.message}`));
      else resolve(true);
    });
  });
}

module.exports = {
  configure,
  dispatch,
  killJob,
  killAll,
  listJobs,
  openInTerminal,
  resolveClaudeBin,
  // exported for the parser test script
  renderStreamObject,
};
