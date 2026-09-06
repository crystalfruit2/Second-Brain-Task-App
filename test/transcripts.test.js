// Runs the transcript reducer over REAL Claude Code transcripts on this machine
// and checks the contract the Reading Room renderer relies on. Plain node:
//
//   node test/transcripts.test.js
//
// Picks three files from the vault's project folder: the largest, the most
// recently modified, and one containing an API-error record. Then opens the
// tail on the transcript of the terminal this script was launched from (if it
// is a Claude session) to check the incremental read path.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  createReducer,
  openTail,
  transcriptPath,
  readSessionInfo,
  projectSlug,
  PROJECTS_DIR,
} = require('../src/transcripts');

const DIR = path.join(PROJECTS_DIR, '-Users-alpeldam-Documents-Projects-second-brain');
const ROLES = new Set(['user', 'assistant', 'tools', 'error']);

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

function pickFiles() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const p = path.join(DIR, f);
      const st = fs.statSync(p);
      return { p, size: st.size, mtime: st.mtimeMs };
    });
  if (!files.length) throw new Error(`no transcripts under ${DIR}`);
  const largest = [...files].sort((a, b) => b.size - a.size)[0].p;
  // Reading Room mini-sessions run with cwd = vault, so their tiny transcripts
  // land in this same folder; "most recent" should still be a real conversation.
  const substantive = files.filter((f) => f.size >= 200 * 1024);
  const recent = [...(substantive.length ? substantive : files)].sort((a, b) => b.mtime - a.mtime)[0].p;
  let withError = null;
  try {
    const out = execFileSync('grep', ['-l', 'isApiErrorMessage":true', ...files.map((f) => f.p)], {
      encoding: 'utf8',
      maxBuffer: 1 << 24,
    });
    withError = out.split('\n').find((l) => l.trim()) || null;
  } catch {
    /* grep exits 1 when nothing matches */
  }
  return [
    ['largest', largest],
    ['most recent', recent],
    ['has api error', withError],
  ].filter(([, p]) => p);
}

// Independent count of assistant messages that should become exactly one turn:
// distinct message.id among non-error, non-sidechain, non-meta assistant
// records that carry at least one non-empty text block.
function expectedAssistantIds(lines) {
  const ids = new Set();
  for (const line of lines) {
    if (!line.includes('"type":"assistant"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== 'assistant' || r.isSidechain === true || r.isMeta === true || r.isApiErrorMessage === true) continue;
    const blocks = (r.message && r.message.content) || [];
    if (!Array.isArray(blocks)) continue;
    if (blocks.some((b) => b && b.type === 'text' && String(b.text || '').trim())) ids.add(r.message.id || r.uuid);
  }
  return ids;
}

function runFile(label, file) {
  console.log(`\n${label}: ${path.basename(file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const r = createReducer();
  let threw = null;
  const t0 = Date.now();
  try {
    for (const line of lines) r.feed(line);
  } catch (e) {
    threw = e;
  }
  check(!threw, `reducer threw: ${threw && threw.stack}`);
  const turns = r.turns;
  const counts = {};
  const seenMsgIds = new Map();
  for (const t of turns) {
    counts[t.role] = (counts[t.role] || 0) + 1;
    check(typeof t.uuid === 'string' && t.uuid, `turn without uuid: ${JSON.stringify(t).slice(0, 120)}`);
    check(ROLES.has(t.role), `bad role ${t.role}`);
    check(t.ts === null || typeof t.ts === 'string', `bad ts on ${t.uuid}`);
    check(typeof t.md === 'string', `md not a string on ${t.uuid}`);
    check(Array.isArray(t.tools), `tools not an array on ${t.uuid}`);
    if (t.role !== 'tools') check(t.tools.length === 0, `non-tools turn carries chips: ${t.uuid}`);
    if (t.role === 'tools') check(t.md === '', `tools turn has md: ${t.uuid}`);
    for (const c of t.tools) {
      check(typeof c.name === 'string' && typeof c.arg === 'string' && typeof c.peek === 'string', `chip shape on ${t.uuid}`);
      check(c.peek.length <= 120, `peek > 120 chars (${c.peek.length}) on ${t.uuid}`);
      check(c.arg.length <= 120, `arg > 120 chars on ${t.uuid}`);
      check(typeof c.isError === 'boolean', `isError not boolean on ${t.uuid}`);
    }
    const lead = t.md.trimStart();
    check(!lead.startsWith('<command-name>'), `command echo leaked: ${t.uuid}`);
    check(!lead.startsWith('<local-command-'), `local-command leaked: ${t.uuid}`);
    check(!/<system-reminder>/.test(t.md), `system-reminder leaked into ${t.uuid}`);
    if (t.role === 'assistant') {
      check(t.msgId, `assistant turn without msgId ${t.uuid}`);
      check(!seenMsgIds.has(t.msgId), `message.id ${t.msgId} produced more than one assistant turn`);
      seenMsgIds.set(t.msgId, t.uuid);
    }
  }
  // Only meaningful when nothing was trimmed by the 200-turn cap.
  const expected = expectedAssistantIds(lines);
  if (turns.length < 200) {
    check(
      expected.size === (counts.assistant || 0),
      `expected ${expected.size} assistant turns (distinct message.id with text), got ${counts.assistant || 0}`
    );
  }
  const uuids = new Set(turns.map((t) => t.uuid));
  check(uuids.size === turns.length, 'duplicate uuids among turns');
  console.log(
    `  ${lines.length} lines → ${turns.length} turns in ${Date.now() - t0} ms; per role: ${JSON.stringify(counts)}; title: ${JSON.stringify(r.title)}`
  );
  console.log(`  distinct assistant message.ids with text in file: ${expected.size}`);
}

async function tailSanity() {
  // Walk up from this process to find the enclosing `claude` (an interactive
  // session has ~/.claude/sessions/<pid>.json).
  let pid = process.ppid;
  let info = null;
  for (let i = 0; i < 6 && pid > 1; i++) {
    info = readSessionInfo(pid);
    if (info) break;
    try {
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    } catch {
      break;
    }
  }
  if (!info) {
    console.log('\ntail: no enclosing Claude session found — skipping tail sanity check');
    return;
  }
  const file = transcriptPath(info.cwd, info.sessionId);
  console.log(`\ntail: pid ${info.pid} session ${info.sessionId} status=${info.status}`);
  console.log(`  slug check: ${projectSlug(info.cwd)}`);
  check(fs.existsSync(file), `transcript missing at ${file}`);
  const reducer = createReducer();
  let batches = 0;
  const tail = await openTail({ file, reducer, onBatch: () => (batches += 1) });
  const size = fs.statSync(file).size;
  check(tail.offset === size, `offset ${tail.offset} != file size ${size} after initial load`);
  check(batches === 0, 'initial load must not report batches');
  console.log(`  initial load: ${reducer.turns.length} turns, offset == size (${size} bytes) ✓`);
  tail.close();
}

// The live path: copy a real transcript's head into a scratch file, open the
// tail on it, append the rest (partial line first, remainder later) and make
// sure fs.watch + the byte offset deliver exactly the appended turns.
async function appendSanity(sourceFile) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rr-tail-'));
  const file = path.join(dir, 'live.jsonl');
  const lines = fs.readFileSync(sourceFile, 'utf8').split('\n').filter(Boolean);
  const cut = Math.floor(lines.length / 2);
  fs.writeFileSync(file, lines.slice(0, cut).join('\n') + '\n');
  const reducer = createReducer();
  const batches = [];
  const tail = await openTail({ file, reducer, onBatch: (turns) => batches.push(turns) });
  const before = reducer.turns.length;
  const rest = lines.slice(cut).join('\n') + '\n';
  // Split mid-line on purpose: the carry buffer must stitch it back together.
  const half = Math.floor(rest.length / 2);
  fs.appendFileSync(file, rest.slice(0, half));
  await new Promise((r) => setTimeout(r, 400));
  fs.appendFileSync(file, rest.slice(half));
  await new Promise((r) => setTimeout(r, 600));
  const full = createReducer();
  for (const l of lines) full.feed(l);
  console.log(`\nappend: ${before} turns before, ${reducer.turns.length} after, ${batches.length} batch(es), expected ${full.turns.length}`);
  check(batches.length >= 1, 'fs.watch never delivered an append batch');
  check(reducer.turns.length === full.turns.length, 'tailed turns differ from one-shot reduction');
  check(tail.offset === fs.statSync(file).size, 'offset != size after appends');
  const touched = new Set(batches.flat().map((t) => t.uuid));
  check(touched.size > 0, 'batches carried no turns');
  tail.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  const files = pickFiles();
  check(files.length === 3, `wanted 3 transcript picks, got ${files.length}`);
  for (const [label, file] of files) runFile(label, file);
  await tailSanity();
  await appendSanity(files[1][1]);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
