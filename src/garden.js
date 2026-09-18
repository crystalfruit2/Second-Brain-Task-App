// Garden — the "is anything wilting?" reader for Mission Control.
//
// One row per Projects/<dir>/ note. Reads, never writes, never spawns. For
// each project it finds the last time Alp actually touched it, from three
// independent signals:
//   1. newest mtime of any .md under Projects/<dir>/ (the note itself)
//   2. last Daily/YYYY-MM-DD.md with *evidence* naming the project
//   3. last ref update in the project's local repo (.git/logs/HEAD, read as a
//      file — no git process), path from frontmatter or the registry's
//      "Local path" column, when that path exists on this machine
// and turns idle days + lane + deadline into a wilt stage and a nag flag.
// All day arithmetic is in the machine's local calendar day.
//
// Rules (mirrored in the vault's .claude/skills/start-day/neglect.py — keep
// the two in step):
//   lane: focus | background | parked   (frontmatter `lane:`; default background)
//   completed/superseded status → excluded; parked → shown folded, never nags
//   focus stages by idle days:      0 ≤1 · 1 = 2–3 · 2 = 4–7 · 3 ≥8
//   background stages:              0 ≤3 · 1 = 4–7 · 2 = 8–14 · 3 ≥15
//   deadline (`deadline: YYYY-MM-DD` or dd.MM.yyyy): daysLeft; urgent ≤3, soon ≤7
//   nag = focus with stage ≥1, or any non-parked with daysLeft ≤7 and idle ≥2
//   score = idle × laneWeight (focus 1, background 0.5) + max(0, 14 − daysLeft)
//   Daily evidence = `- [x]` lines anywhere + lines under Journal / Notes &
//   Links / Pomodoro Log / End of Day. Open tasks, intentions, schedule: no.
//   Lines that talk about neglect (dokunulmadı/untouched/wilting…) never count.
//   Aliases match on word boundaries; an alias that is a word-prefix of
//   another project's alias is dropped ("second brain" vs "second brain capture").
const fs = require('fs');
const path = require('path');

const DAY_MS = 86_400_000;
const LANE_WEIGHT = { focus: 1, background: 0.5, parked: 0 };
const STAGE_EDGES = { focus: [1, 3, 7], background: [3, 7, 14], parked: [3, 7, 14] };
const DONE_RE = /^(completed|superseded|done|killed|archived)\b/i;
const SIGNAL_ORDER = ['note', 'daily', 'commit']; // tie on the same day → earlier wins

// ---------- small pure helpers ----------

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || ''));
  return m ? { fmText: m[1], body: text.slice(m[0].length) } : { fmText: '', body: String(text || '') };
}

function frontmatter(text) {
  const { fmText } = splitFrontmatter(text);
  const out = {};
  for (const line of fmText.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, '').trim(); // strip trailing YAML comment
    v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    out[kv[1]] = v;
  }
  return out;
}

function firstHeading(body) {
  const m = /^#\s+(.+)$/m.exec(String(body || ''));
  return m ? m[1].trim() : '';
}

// Local calendar day, as a Date at local midnight.
function localDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t); // the vault's dd.MM.yyyy habit
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

function daysBetween(later, earlier) {
  return Math.round((localDay(later) - localDay(earlier)) / DAY_MS);
}

function laneOf(fm) {
  const l = String(fm.lane || '').trim().toLowerCase();
  return l === 'focus' || l === 'parked' ? l : 'background';
}

function stageFor(lane, idleDays) {
  if (idleDays == null) return 3;
  const [a, b, c] = STAGE_EDGES[lane] || STAGE_EDGES.background;
  if (idleDays <= a) return 0;
  if (idleDays <= b) return 1;
  if (idleDays <= c) return 2;
  return 3;
}

function assess({ lane, idleDays, daysLeft }) {
  const stage = stageFor(lane, idleDays);
  const idle = idleDays == null ? 30 : idleDays;
  const weight = LANE_WEIGHT[lane] ?? 0.5;
  let score = idle * weight;
  if (daysLeft != null) score += Math.max(0, 14 - daysLeft);
  const nag =
    lane !== 'parked' &&
    ((lane === 'focus' && stage >= 1) || (daysLeft != null && daysLeft <= 7 && idle >= 2));
  return { stage, score: Math.round(score * 10) / 10, nag };
}

// A local repo path: `~/…` or an absolute macOS path under a real top-level
// dir. Bare `/finance`-style URL paths and Windows paths never match.
const LOCAL_PATH_RE = /(~\/[^\s`)\]|*,;]+|\/(?:Users|Volumes|private|var|tmp|opt)\/[^\s`)\]|*,;]+)/;

function localPathFrom(text) {
  const m = LOCAL_PATH_RE.exec(String(text || ''));
  if (!m) return null;
  let p = m[1].replace(/[.,:;]+$/, '');
  if (p.startsWith('~/')) p = path.join(process.env.HOME || '', p.slice(2));
  return p;
}

function splitCells(row) {
  return String(row || '').trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function registryRowFor(registryText, dir) {
  const needle = `[[Projects/${dir}`;
  const alt = `[[${dir}`;
  for (const line of String(registryText || '').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (line.includes(needle) || line.includes(alt)) return line;
  }
  return null;
}

function registryNameOf(row) {
  if (!row) return '';
  const cells = splitCells(row);
  return (cells[0] || '').replace(/\[\[[^\]]*\|([^\]]+)\]\]/g, '$1').replace(/\*\*/g, '');
}

// Registry columns: Project | Status | Local path | Graph? — only the third counts.
function registryPathOf(row) {
  if (!row) return null;
  const cells = splitCells(row);
  return localPathFrom(cells[2] || '');
}

// ---------- signals ----------

function newestMtime(dir) {
  let best = 0;
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.md')) continue;
      try { best = Math.max(best, fs.statSync(p).mtimeMs); } catch {}
    }
  };
  walk(dir, 0);
  return best ? new Date(best) : null;
}

// A daily note "mentions" a project only where work is evidenced (see header).
const EVIDENCE_SECTION_RE = /^##\s+(journal|notes|pomodoro|end of day|log|günlük|gün sonu)/i;
// A line *about* neglect ("Bosum 3 gündür dokunulmadı", written by Rocky) must
// never count as touching the project it names — or the nag resets itself.
const NEGLECT_TALK_RE = /dokunulmad|dokunmad|untouched|wilting|solma|solan|neglect|ihmal/i;

function evidenceText(text) {
  const out = [];
  let inEvidence = false;
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^##\s/.test(line)) { inEvidence = EVIDENCE_SECTION_RE.test(line); continue; }
    if (/^#/.test(line) || !line || NEGLECT_TALK_RE.test(line)) continue;
    if (/^[-*]\s+\[x\]/i.test(line)) { out.push(line); continue; }
    if (inEvidence && !/^[-*]\s+\[ \]/.test(line)) out.push(line);
  }
  return out.join('\n').toLowerCase();
}

function dateFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(name || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// Read the last N daily notes once; every project scans the same cache.
function loadDailies(vaultPath, days = 45) {
  const dir = path.join(vaultPath, 'Daily');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)); } catch { return []; }
  names.sort().reverse();
  const out = [];
  for (const n of names.slice(0, days)) {
    try { out.push({ date: dateFromName(n), text: evidenceText(fs.readFileSync(path.join(dir, n), 'utf8')) }); } catch {}
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Aliases a daily note would plausibly use: the folder name, its spaced form,
// the note's H1 (up to a dash/paren), frontmatter aliases, the registry name.
function aliasesFor(dir, fm, heading, registryName) {
  const set = new Set();
  const add = (s) => {
    const t = String(s || '').trim().toLowerCase();
    if (t.length >= 4) set.add(t);
  };
  add(dir);
  add(dir.replace(/[-_]+/g, ' '));
  add(`projects/${dir.toLowerCase()}`);
  add(heading.split(/\s[—–(:]/)[0]);
  add(String(fm.codename || '').split(/[\/(]/)[0]);
  for (const a of String(fm.aliases || '').replace(/[\[\]]/g, '').split(',')) add(a);
  add(registryName.split(/\s[—–(]/)[0]);
  return [...set];
}

// Drop an alias that is a word-prefix of another project's alias, so
// "second brain" does not swallow "second brain capture".
function pruneAliases(aliasesByDir) {
  const all = [];
  for (const [dir, list] of Object.entries(aliasesByDir)) for (const a of list) all.push({ dir, a });
  const out = {};
  for (const [dir, list] of Object.entries(aliasesByDir)) {
    out[dir] = list.filter((a) => !all.some((o) => o.dir !== dir && o.a !== a && o.a.startsWith(a + ' ')));
  }
  return out;
}

function aliasRegex(aliases) {
  if (!aliases.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${aliases.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

function lastDailyMention(dailies, aliases) {
  const re = aliasRegex(aliases);
  if (!re) return null;
  for (const d of dailies) if (re.test(d.text)) return d.date;
  return null;
}

// Last ref update from .git/logs/HEAD — last line ends "<epoch> <tz>\t<msg>".
// A plain file read: no git process, nothing to block the main thread on.
function repoLastCommit(repoPath) {
  if (!repoPath) return null;
  const gitDir = path.join(repoPath, '.git');
  let logPath = path.join(gitDir, 'logs', 'HEAD');
  try {
    const st = fs.statSync(gitDir);
    if (st.isFile()) { // worktree: ".git" is a pointer file
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'));
      if (m) logPath = path.join(path.resolve(repoPath, m[1].trim()), 'logs', 'HEAD');
    }
    const size = fs.statSync(logPath).size;
    if (!size) return null;
    const fd = fs.openSync(logPath, 'r');
    let tail = '';
    try {
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = tail.split('\n').filter(Boolean);
    const last = lines[lines.length - 1] || '';
    const m = /\s(\d{9,11})\s[+-]\d{4}\t/.exec(last);
    return m ? new Date(+m[1] * 1000) : null;
  } catch { return null; }
}

// ---------- seeds (Areas/Idea-Garden.md → 🌰 Seeds section) ----------

function parseSeeds(text, limit = 12) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const seeds = [];
  let inSeeds = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inSeeds = /^##\s+🌰/.test(line); continue; }
    if (!inSeeds) continue;
    let m = /^-\s+🌰\s+\*\*(\d{4}-\d{2}-\d{2})\s+[—–-]+\s+(.+?):?\*\*/.exec(line);
    if (m) { seeds.push({ title: m[2].trim(), date: m[1] }); continue; }
    m = /^###\s+🌰\s+(.+?)(?:\s+\((\d{4}-\d{2}-\d{2})[^)]*\))?\s*$/.exec(line);
    if (m) seeds.push({ title: m[1].trim(), date: m[2] || '' });
  }
  return { total: seeds.length, items: seeds.slice(0, limit) };
}

// ---------- the reader ----------

function readGarden(vaultPath, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const projectsDir = path.join(vaultPath, 'Projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return { available: false, projects: [], seeds: { total: 0, items: [] }, generatedAt: now.toISOString() };
  }
  let registry = '';
  try { registry = fs.readFileSync(path.join(vaultPath, 'Resources', 'project-registry.md'), 'utf8'); } catch {}
  const dailies = loadDailies(vaultPath);

  // Pass 1: read notes, build aliases for every project (pruning needs all).
  const drafts = [];
  const aliasesByDir = {};
  for (const dir of dirs) {
    const full = path.join(projectsDir, dir);
    let noteFile = path.join(full, `${dir}.md`);
    let text = null;
    try {
      if (!fs.statSync(noteFile).isFile()) throw new Error('not a file');
      text = fs.readFileSync(noteFile, 'utf8');
    } catch {
      try {
        const any = fs.readdirSync(full).filter((n) => n.endsWith('.md')).sort()[0];
        if (!any) continue;
        noteFile = path.join(full, any);
        text = fs.readFileSync(noteFile, 'utf8');
      } catch { continue; }
    }
    const fm = frontmatter(text);
    const status = String(fm.status || '').trim();
    if (DONE_RE.test(status)) continue;
    const row = registryRowFor(registry, dir);
    const registryName = registryNameOf(row);
    const heading = firstHeading(splitFrontmatter(text).body);
    aliasesByDir[dir] = aliasesFor(dir, fm, heading, registryName);
    drafts.push({ dir, full, noteFile, fm, status, row, registryName, heading });
  }
  const aliases = pruneAliases(aliasesByDir);

  // Pass 2: signals → assessment.
  const projects = [];
  for (const d of drafts) {
    const { dir, full, noteFile, fm, status, row, registryName, heading } = d;
    const lane = laneOf(fm);
    const deadline = parseDate(fm.deadline);
    const repoPath = localPathFrom(fm.repo) || localPathFrom(fm.path) || registryPathOf(row);

    const signals = { note: newestMtime(full), daily: lastDailyMention(dailies, aliases[dir] || []), commit: repoLastCommit(repoPath) };
    let lastTouch = null;
    let via = null;
    for (const k of SIGNAL_ORDER) {
      const v = signals[k];
      if (v && (!lastTouch || localDay(v) > localDay(lastTouch))) { lastTouch = v; via = k; }
    }
    const idleDays = lastTouch ? Math.max(0, daysBetween(now, lastTouch)) : null;
    const daysLeft = deadline ? daysBetween(deadline, now) : null;
    const { stage, score, nag } = assess({ lane, idleDays, daysLeft });

    projects.push({
      dir,
      file: path.relative(vaultPath, noteFile).split(path.sep).join('/'),
      name: (heading || registryName || dir).replace(/\s*[—–:(]\s?.*$/, '').trim().slice(0, 48),
      status,
      lane,
      deadline: deadline ? `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}-${String(deadline.getDate()).padStart(2, '0')}` : null,
      deadlineLabel: fm['deadline-label'] || fm.deadline_label || '',
      daysLeft,
      idleDays,
      lastTouch: lastTouch ? lastTouch.toISOString() : null,
      via,
      stage,
      score,
      nag,
      repo: repoPath,
    });
  }

  const laneRank = { focus: 0, background: 1, parked: 2 };
  projects.sort((a, b) => (laneRank[a.lane] - laneRank[b.lane]) || (b.score - a.score) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  let seeds = { total: 0, items: [] };
  try { seeds = parseSeeds(fs.readFileSync(path.join(vaultPath, 'Areas', 'Idea-Garden.md'), 'utf8')); } catch {}

  return { available: true, projects, seeds, generatedAt: now.toISOString() };
}

module.exports = {
  readGarden,
  assess,
  stageFor,
  frontmatter,
  firstHeading,
  splitFrontmatter,
  parseDate,
  parseSeeds,
  aliasesFor,
  pruneAliases,
  lastDailyMention,
  localPathFrom,
  registryRowFor,
  registryPathOf,
  repoLastCommit,
  evidenceText,
  daysBetween,
};

// `node src/garden.js [vaultPath]` — quick CLI check against a real vault.
if (require.main === module) {
  const vp = process.argv[2] || require('./config').VAULT_PATH;
  const g = readGarden(vp);
  for (const p of g.projects) {
    console.log(
      `${p.nag ? '!' : ' '} ${p.lane.padEnd(10)} s${p.stage} ${String(p.idleDays ?? '?').padStart(3)}d via ${String(p.via).padEnd(6)} ` +
        `${p.daysLeft != null ? `${p.daysLeft}d left` : '        '}  ${p.name}`,
    );
  }
  console.log(`seeds: ${g.seeds.total}`);
}
