// Vault read/write helpers. The main process owns all filesystem access;
// the renderer only talks to these via IPC (see main.js + preload.js).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { VAULT_PATH } = require('./config');

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local (not UTC) date so the daily note matches the vault's YYYY-MM-DD convention.
function todayStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dailyNotePath(date = new Date()) {
  return path.join(VAULT_PATH, 'Daily', `${todayStamp(date)}.md`);
}

// Minimal daily note if one doesn't exist yet — enough to hold captures without
// clobbering the real /start-day template if that runs later.
function seedDailyNote(date = new Date()) {
  const stamp = todayStamp(date);
  return `---\ndate: ${stamp}\ntags:\n  - journal\n---\n\n# ${stamp}\n\n## Quick Notes\n> Captured from the Notes widget\n\n`;
}

const QUICK_NOTES_HEADING = '## Quick Notes';

// Insert a Quick Notes section if missing, preferring to place it just before the
// Pomodoro Log / End-of-Day block so it lands with the day's other running logs.
function ensureQuickNotesSection(content) {
  if (content.includes(QUICK_NOTES_HEADING)) return content;

  const block = `${QUICK_NOTES_HEADING}\n> Captured from the Notes widget\n\n`;
  const anchors = ['## Pomodoro Log', '\n---\n## End of Day', '\n---\n'];
  for (const anchor of anchors) {
    const idx = content.indexOf(anchor);
    if (idx !== -1) {
      return content.slice(0, idx) + block + '\n' + content.slice(idx);
    }
  }
  // No anchor found — append at the end.
  const sep = content.endsWith('\n') ? '' : '\n';
  return content + sep + '\n' + block;
}

// Append a single capture as a timestamped bullet under Quick Notes.
// Multi-line captures are indented as a continuation of the bullet.
function appendNote(text, date = new Date()) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty note');

  const file = dailyNotePath(date);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let content = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : seedDailyNote(date);

  content = ensureQuickNotesSection(content);

  const lines = trimmed.split(/\r?\n/);
  const bullet =
    `- ${timeStamp(date)} — ${lines[0]}` +
    lines.slice(1).map((l) => `\n  ${l}`).join('');

  // Insert right after the Quick Notes heading (and its optional blockquote line).
  const headingIdx = content.indexOf(QUICK_NOTES_HEADING);
  const afterHeading = content.indexOf('\n', headingIdx) + 1;
  let insertAt = afterHeading;
  // Skip a leading "> ..." blockquote line and one blank line so new notes stack
  // newest-last under the existing ones.
  const rest = content.slice(afterHeading);
  const restLines = rest.split('\n');
  let consumed = 0;
  for (const l of restLines) {
    if (l.startsWith('>') || l.trim() === '' || l.startsWith('- ') || l.startsWith('  ')) {
      consumed += l.length + 1;
    } else {
      break;
    }
  }
  // Append after the last existing note line in the section.
  insertAt = afterHeading + consumed;

  const before = content.slice(0, insertAt).replace(/\n*$/, '\n');
  const after = content.slice(insertAt).replace(/^\n*/, '');
  content = before + bullet + '\n' + (after ? '\n' + after : '');

  fs.writeFileSync(file, content, 'utf8');
  return { file, bullet, date: todayStamp(date) };
}

// Read today's captures back so the widget can show recent notes.
function readTodayNotes(date = new Date()) {
  const file = dailyNotePath(date);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const headingIdx = content.indexOf(QUICK_NOTES_HEADING);
  if (headingIdx === -1) return [];
  const section = content.slice(headingIdx);
  const end = section.indexOf('\n## ', 3);
  const body = end === -1 ? section : section.slice(0, end);
  return body
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/^-\s*/, ''));
}

// Append a completed focus/pomodoro session to AI/pomodoro-log.json with
// logged:false, so the existing `/pomodoro` "log session" flow syncs it to the
// vault (daily note + matched Learning note) exactly as before. This is the one
// integration point between the widget's timer and the vault.
function appendPomodoroSession(session, date = new Date()) {
  const file = path.join(VAULT_PATH, 'AI', 'pomodoro-log.json');
  let arr = [];
  if (fs.existsSync(file)) {
    try {
      arr = JSON.parse(fs.readFileSync(file, 'utf8')) || [];
    } catch {
      arr = [];
    }
  }
  const entry = {
    date: todayStamp(date),
    time: timeStamp(date),
    label: String(session.label || '').trim(),
    duration: Math.max(0, Math.round(session.duration || 0)),
    pomodoros: Math.max(0, Math.round(session.pomodoros || 0)),
    mode: session.mode === 'pomodoro' ? 'pomodoro' : 'focus',
    completed: !!session.completed,
    logged: false,
  };
  arr.push(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
  return entry;
}

// ---------------------------------------------------------------------------
// Cigarette counter: a tally kept inside the day's `### Health log — DATE`
// section (the same section Claude already writes by hand — see
// Areas/Health.md), as a single `- 🚬 N cigarettes` line that gets
// incremented/decremented in place rather than appended as a growing list.
// ---------------------------------------------------------------------------

const CIG_LINE_RE = /^- 🚬 (\d+) cigarettes?$/m;

function healthLogHeading(date) {
  return `### Health log — ${todayStamp(date)}`;
}

// Bounded section body: from just after `heading`'s line up to the next
// `##`/`###` heading, or end of file. Health log is a level-3 heading nested
// among level-2 sections, so unlike sectionBody() (tasks) this stops at
// either level.
function boundedSection(content, heading) {
  const idx = content.indexOf(heading);
  if (idx === -1) return null;
  const start = content.indexOf('\n', idx) + 1;
  const rest = content.slice(start);
  const nextIdx = rest.search(/\n#{2,3} /);
  const end = nextIdx === -1 ? rest.length : nextIdx + 1;
  return { start, end: start + end, body: rest.slice(0, end) };
}

// Insert the Health log section if missing, at the same anchor point Quick
// Notes uses, so the day's running logs stay grouped together.
function ensureHealthLogSection(content, date) {
  const heading = healthLogHeading(date);
  if (content.includes(heading)) return content;

  const block = `${heading}\n> Rolls up to [[Health]]\n- 🚬 0 cigarettes\n\n`;
  const anchors = ['## Pomodoro Log', '\n---\n## End of Day', '\n---\n'];
  for (const anchor of anchors) {
    const idx = content.indexOf(anchor);
    if (idx !== -1) {
      return content.slice(0, idx) + block + '\n' + content.slice(idx);
    }
  }
  const sep = content.endsWith('\n') ? '' : '\n';
  return content + sep + '\n' + block;
}

function getCigCount(date = new Date()) {
  const file = dailyNotePath(date);
  if (!fs.existsSync(file)) return 0;
  const content = fs.readFileSync(file, 'utf8');
  const sec = boundedSection(content, healthLogHeading(date));
  if (!sec) return 0;
  const m = sec.body.match(CIG_LINE_RE);
  return m ? parseInt(m[1], 10) : 0;
}

// delta=+1 to log one, delta=-1 to undo a misclick. Floors at 0.
function logCigarette(delta = 1, date = new Date()) {
  const file = dailyNotePath(date);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : seedDailyNote(date);
  content = ensureHealthLogSection(content, date);

  const heading = healthLogHeading(date);
  const sec = boundedSection(content, heading);
  const current = (sec.body.match(CIG_LINE_RE) || [])[1];
  const next = Math.max(0, (current ? parseInt(current, 10) : 0) + delta);
  const line = `- 🚬 ${next} cigarette${next === 1 ? '' : 's'}`;

  let body;
  if (CIG_LINE_RE.test(sec.body)) {
    body = sec.body.replace(CIG_LINE_RE, line);
  } else {
    const lines = sec.body.split('\n');
    const insertAt = lines[0] && lines[0].startsWith('>') ? 1 : 0;
    lines.splice(insertAt, 0, line);
    body = lines.join('\n');
  }

  content = content.slice(0, sec.start) + body + content.slice(sec.end);
  fs.writeFileSync(file, content, 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// Tasks / Reading dashboard: aggregate `## Tasks` checkboxes across the last
// N days of Daily notes, and write toggles back to the exact source line.
// ---------------------------------------------------------------------------

const TASKS_HEADING = '## Tasks';

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Body of a `## heading` section: from just after the heading line up to
// (not including) the next `## ` heading, or end of file.
//
// The heading is matched as a *whole line*, not as a substring: a `### Tasks`
// sub-heading or a sentence that merely mentions `## Tasks` earlier in the note
// used to win the `indexOf` race and either hijack or empty the section. The
// trailing `\r?` keeps CRLF notes (edited on the Windows box) working.
function sectionBody(content, heading) {
  const m = new RegExp(`^${escapeRe(heading)}[ \\t]*\\r?$`, 'm').exec(content);
  if (!m) return null;
  const nl = content.indexOf('\n', m.index);
  if (nl === -1) return { start: content.length, body: '' }; // heading is the last line
  const start = nl + 1;
  const rest = content.slice(start);
  const nextHeading = rest.search(/\n## /);
  const bodyEnd = nextHeading === -1 ? rest.length : nextHeading + 1;
  return { start, body: rest.slice(0, bodyEnd) };
}

function parseCheckboxLines(body) {
  const lines = body.split(/\r?\n/);
  const items = [];
  lines.forEach((line, i) => {
    const m = line.match(/^- \[([ xX])\]\s+(.*?)\s*$/);
    if (m) items.push({ lineIndex: i, checked: m[1].toLowerCase() === 'x', raw: line, text: m[2] });
  });
  return items;
}

// "Reading while training runs: ..." style items already used in daily notes —
// no separate heading exists yet, so classify by leading word.
function isReadingItem(text) {
  return /^reading\b/i.test(text.trim());
}

function listDailyFiles(daysBack = 7) {
  const dir = path.join(VAULT_PATH, 'Daily');
  const files = [];
  const today = new Date();
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const stamp = todayStamp(d);
    const file = path.join(dir, `${stamp}.md`);
    if (fs.existsSync(file)) files.push({ file, date: stamp });
  }
  return files;
}

// All checkbox items from `## Tasks` across today + the last `daysBack` days.
function listTasks(daysBack = 7) {
  const out = [];
  for (const { file, date } of listDailyFiles(daysBack)) {
    const content = fs.readFileSync(file, 'utf8');
    const sec = sectionBody(content, TASKS_HEADING);
    if (!sec) continue;
    const lineOffset = content.slice(0, sec.start).split('\n').length - 1;
    for (const it of parseCheckboxLines(sec.body)) {
      out.push({
        file,
        date,
        line: lineOffset + it.lineIndex,
        raw: it.raw,
        text: it.text,
        checked: it.checked,
        kind: isReadingItem(it.text) ? 'reading' : 'task',
      });
    }
  }
  return out;
}

// Index of the line equal to `raw` that sits *closest* to `hint`, searching
// outward in both directions. Two identical task lines in one note are normal
// ("- [ ] mail Farzad" twice in a week); if the file shifted under us, the one
// I clicked is the one near where it was, not the first one in the file.
function nearestMatchingLine(lines, raw, hint) {
  const from = Number.isInteger(hint) ? hint : 0;
  const span = Math.max(from, lines.length - from) + 1;
  for (let d = 0; d <= span; d++) {
    const back = from - d;
    if (back >= 0 && lines[back] === raw) return back;
    const fwd = from + d;
    if (d && fwd < lines.length && lines[fwd] === raw) return fwd;
  }
  return -1;
}

// Flip `- [ ]` <-> `- [x]` on one line of one file. `line`/`raw` come from
// listTasks() and are used to re-locate the exact line even if earlier lines
// in the file shifted; falls back to the nearest identical line if the file
// changed. Line endings are preserved as found, so toggling a CRLF note
// doesn't silently rewrite the whole file to LF.
function toggleTaskLine(file, line, raw) {
  const content = fs.readFileSync(file, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let at = line;
  if (lines[at] !== raw) {
    at = nearestMatchingLine(lines, raw, line);
    if (at === -1) throw new Error('That task line no longer matches the note — it may have changed.');
  }
  const toggled = /^- \[ \]/.test(raw)
    ? raw.replace('- [ ]', '- [x]')
    : raw.replace(/^- \[[xX]\]/, '- [ ]');
  lines[at] = toggled;
  fs.writeFileSync(file, lines.join(eol), 'utf8');
  return { file, line: at, raw: toggled, checked: /^- \[[xX]\]/.test(toggled) };
}

// ---------------------------------------------------------------------------
// Projects panel: parse Resources/project-registry.md's table.
// ---------------------------------------------------------------------------

function splitRow(line) {
  // Split on unescaped `|` only — cells use `\|` inside wikilink aliases
  // (e.g. [[Foo\|Bar]]) — then trim and unescape.
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function listProjects() {
  const file = path.join(VAULT_PATH, 'Resources', 'project-registry.md');
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const rows = [];
  let inTable = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // separator row
    const cells = splitRow(trimmed);
    if (cells[0] === 'Project') continue; // header row
    rows.push({
      name: cells[0] || '',
      status: cells[1] || '',
      path: cells[2] || '',
      graph: cells[3] || '',
    });
  }
  return rows;
}

// Same rows, but with the status cell cut down to one short line. The registry
// keeps whole paragraphs in that cell (DARE-MOT's alone is ~11KB), and Mission
// Control's Projects panel clamps to a single line anyway — so shipping the
// full prose across IPC was paying for text nobody can see. The Dashboard still
// calls listProjects() and gets everything, unchanged.
const PROJECT_STATUS_CHARS = 200;

function listProjectsBrief() {
  return listProjects().map((p) => {
    const oneLine = String(p.status || '').split(/<br\s*\/?>|\r?\n/)[0].trim();
    return {
      ...p,
      status:
        oneLine.length > PROJECT_STATUS_CHARS
          ? oneLine.slice(0, PROJECT_STATUS_CHARS - 1).trimEnd() + '…'
          : oneLine,
    };
  });
}

// ---------------------------------------------------------------------------
// Article reading sessions: a structured note (title/url/source, verbatim
// Highlights vs. your own Thoughts, a forced Key Takeaway) saved straight to
// Resources/ as a real vault note — not a growing log like Quick Notes, one
// file per article. A single in-progress draft is mirrored to
// AI/article-draft.json (debounced from the renderer) so switching tabs, or
// even quitting mid-read, doesn't lose typed notes before you hit Save.
// ---------------------------------------------------------------------------

const ARTICLE_DRAFT_FILE = () => path.join(VAULT_PATH, 'AI', 'article-draft.json');

// Filesystem-safe title -> filename, deduped against existing Resources notes
// the same way Obsidian/Explorer would ("Title.md", "Title (2).md", ...).
function uniqueResourcePath(title) {
  const base = title.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 120) || 'Untitled Article';
  const dir = path.join(VAULT_PATH, 'Resources');
  let file = path.join(dir, `${base}.md`);
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(dir, `${base} (${n}).md`);
    n++;
  }
  return file;
}

// Writes one Resources/*.md note per article and clears the draft on success.
// Title and a Key Takeaway are required — everything else is optional, since
// a highlight-free "just my thoughts" note is still a valid capture.
function saveArticleNote(data, date = new Date()) {
  const title = String(data.title || '').trim();
  if (!title) throw new Error('Title is required');
  const takeaway = String(data.takeaway || '').trim();
  if (!takeaway) throw new Error('Add a key takeaway before saving');

  const url = String(data.url || '').trim();
  const source = String(data.source || '').trim();
  const highlights = String(data.highlights || '').trim();
  const thoughts = String(data.thoughts || '').trim();

  const dir = path.join(VAULT_PATH, 'Resources');
  fs.mkdirSync(dir, { recursive: true });
  const file = uniqueResourcePath(title);

  const fm = ['---', 'tags:', '  - resource', '  - article', '  - needs-review', 'status: reference', `created: ${todayStamp(date)}`];
  if (url) fm.push(`source: ${url}`);
  if (source) fm.push(`author: ${source}`);
  fm.push('---', '');

  const body = [`# ${title}`, ''];
  if (url) body.push(`> [Source](${url})${source ? ` — ${source}` : ''}`, '');
  body.push('## Key Takeaway', takeaway, '');
  if (highlights) body.push('## Highlights', highlights, '');
  if (thoughts) body.push('## My Thoughts', thoughts, '');

  const content = fm.concat(body).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  fs.writeFileSync(file, content, 'utf8');
  clearArticleDraft();
  return { file, title };
}

function readArticleDraft() {
  const file = ARTICLE_DRAFT_FILE();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Debounced from the renderer on every keystroke — cheap single-object
// overwrite, not an append log, since there's only ever one draft in flight.
function saveArticleDraft(draft) {
  const file = ARTICLE_DRAFT_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    title: draft.title || '',
    url: draft.url || '',
    source: draft.source || '',
    highlights: draft.highlights || '',
    thoughts: draft.thoughts || '',
    takeaway: draft.takeaway || '',
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function clearArticleDraft() {
  const file = ARTICLE_DRAFT_FILE();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ---------------------------------------------------------------------------
// Session notes: a free-form scratchpad per Claude Code session (matched by
// slug — see src/sessions.js), so re-opening a terminal you haven't touched in
// days shows the "read this first" context you left yourself, e.g. a review
// checklist. One real markdown file per session under AI/session-notes/, not
// a JSON blob — so these are readable/editable from inside a vault session too.
// ---------------------------------------------------------------------------

function sessionNotesDir() {
  return path.join(VAULT_PATH, 'AI', 'session-notes');
}

function sessionNotesPath(slug) {
  const safe = String(slug || 'session').replace(/[^a-z0-9-]/gi, '-');
  return path.join(sessionNotesDir(), `${safe}.md`);
}

function hasSessionNotes(slug) {
  return fs.existsSync(sessionNotesPath(slug));
}

function readSessionNotes(slug) {
  const file = sessionNotesPath(slug);
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf8');
  // Strip the frontmatter header back out — the widget edits body text only.
  return content.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
}

// Checkbox items (`- [ ]`/`- [x]`) written inside a session's own notes file —
// the widget's Tasks tab reads *this*, not the vault-wide daily-note tasks,
// so it stays a short, hand-written checklist for whatever you're actually
// following through right now instead of a 70-item firehose. Reuses the same
// parseCheckboxLines()/toggleTaskLine() the daily Tasks/Reading columns use —
// toggleTaskLine already takes a plain (file, line, raw) triple, so no new
// write-back logic needed, just a different source file.
function listSessionTaskItems(slug) {
  const file = sessionNotesPath(slug);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  return parseCheckboxLines(content).map((it) => ({
    file,
    line: it.lineIndex,
    raw: it.raw,
    text: it.text,
    checked: it.checked,
  }));
}

function saveSessionNotes(slug, name, text) {
  const dir = sessionNotesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = sessionNotesPath(slug);
  const fm = ['---', 'tags:', '  - session-notes', `session: ${name || slug}`, `updated: ${todayStamp()}`, '---', '', ''];
  const body = String(text || '');
  fs.writeFileSync(file, fm.join('\n') + body + (body.endsWith('\n') ? '' : '\n'), 'utf8');
  return { file };
}

// ---------------------------------------------------------------------------
// Mission Control panels. Everything below is READ-ONLY on the vault (the one
// exception being the task toggle, which reuses toggleTaskLine above) and every
// function returns a quiet empty shape rather than throwing when the file it
// wants is missing or shaped differently than expected — a panel that can't
// parse its source should go blank, not take the window down with it.
// ---------------------------------------------------------------------------

// Today's `## Tasks` only, grouped by whatever `### ` sub-headings the day uses
// (my daily notes bucket tasks under things like "Bugünün işi" / "Devam eden").
// Line indices are absolute in the file, so these items feed toggleTaskLine()
// unchanged.
function listTodayTasks(date = new Date()) {
  const file = dailyNotePath(date);
  if (!fs.existsSync(file)) return [];
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const sec = sectionBody(content, TASKS_HEADING);
  if (!sec) return [];

  const lineOffset = content.slice(0, sec.start).split('\n').length - 1;
  const lines = sec.body.split(/\r?\n/);
  const out = [];
  let group = '';
  lines.forEach((line, i) => {
    const heading = line.match(/^#{3,}\s+(.*?)\s*$/);
    if (heading) {
      group = heading[1].trim();
      return;
    }
    const m = line.match(/^- \[([ xX])\]\s+(.*?)\s*$/);
    if (!m) return;
    out.push({
      file,
      date: todayStamp(date),
      line: lineOffset + i,
      raw: line,
      text: m[2],
      checked: m[1].toLowerCase() === 'x',
      group,
    });
  });
  return out;
}

// Areas/Life-Threads.md: `## <status> threads` sections, one `### ` per thread,
// then `- **Why it matters:** / **Latest movement:** / **Next pull:**` bullets.
// "Latest movement" is appended to over time (a thread can carry a dozen of
// them), so the last one in the file is the current one.
const THREAD_FIELDS = {
  'why it matters': 'why',
  'latest movement': 'latest',
  'next pull': 'next',
};

function cleanFieldValue(s) {
  return String(s || '')
    .trim()
    .replace(/^_+|_+$/g, '') // movements are wrapped in italics
    .trim();
}

function listLifeThreads() {
  const file = path.join(VAULT_PATH, 'Areas', 'Life-Threads.md');
  if (!fs.existsSync(file)) return [];
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const threads = [];
  let section = '';
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.*?)\s*$/);
    if (h2) {
      // "🔥 Active threads" -> "Active threads"
      section = h2[1].replace(/[^\p{L}\p{N}\s'-]/gu, '').trim();
      current = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.*?)\s*$/);
    if (h3) {
      current = { name: h3[1].trim(), section, why: '', latest: '', next: '' };
      threads.push(current);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^-\s+\*\*([^:*]+):\*\*\s*(.*?)\s*$/);
    if (!field) continue;
    const key = THREAD_FIELDS[field[1].trim().toLowerCase()];
    if (key) current[key] = cleanFieldValue(field[2]);
  }
  return threads;
}

// Unrouted Inbox captures. Counts `.md` files only (the `attachments/` folder
// isn't a capture), and flags the ones the phone app dropped in
// (`source: mobile` frontmatter) since those are what /process-inbox exists for.
function readInbox() {
  const dir = path.join(VAULT_PATH, 'Inbox');
  if (!fs.existsSync(dir)) return { total: 0, mobile: 0, items: [] };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { total: 0, mobile: 0, items: [] };
  }

  const items = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let source = '';
    try {
      // Only the frontmatter block matters here — don't read a whole capture in
      // just to learn where it came from.
      const head = fs.readFileSync(file, 'utf8').slice(0, 1200);
      const fm = head.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const m = fm[1].match(/^source:\s*(.+)$/m);
        if (m) source = m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch {
      /* unreadable capture still counts as an item */
    }
    items.push({ file, name: name.replace(/\.md$/, ''), source, mtime: stat.mtimeMs });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { total: items.length, mobile: items.filter((i) => i.source === 'mobile').length, items };
}

// Areas/Health.md's `## Trend log` markdown table, newest row first, plus
// whether today's daily note has a `### Health log — DATE` section yet (the one
// the widget's 🚬 counter writes into).
function readHealth(limit = 5, date = new Date()) {
  const empty = { rows: [], columns: [], loggedToday: false };
  const file = path.join(VAULT_PATH, 'Areas', 'Health.md');
  if (!fs.existsSync(file)) return empty;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }

  const sec = sectionBody(content, '## Trend log');
  if (!sec) return { ...empty, loggedToday: healthLoggedToday(date) };

  let columns = [];
  const rows = [];
  for (const line of sec.body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator row
    const cells = splitRow(t);
    if (!columns.length) {
      columns = cells;
      continue;
    }
    rows.push({ date: cells[0] || '', cells });
  }
  // Table is written oldest-first; the panel wants the recent end.
  rows.reverse();
  return { rows: rows.slice(0, limit), columns, loggedToday: healthLoggedToday(date) };
}

function healthLoggedToday(date = new Date()) {
  const file = dailyNotePath(date);
  if (!fs.existsSync(file)) return false;
  try {
    return fs.readFileSync(file, 'utf8').includes(healthLogHeading(date));
  } catch {
    return false;
  }
}

// ISO-8601 week number + the year that week belongs to (which is not always the
// calendar year — Dec 29 2025 is in 2026-W01).
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday of this week decides which year+week the whole week belongs to.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t - jan1) / 86_400_000 + 1) / 7);
  return { year, week };
}

// "Reviews are Claude's job to remember, not Alp's" — so the window checks
// instead of me. The most recent *completed* ISO week is simply the one seven
// days ago, whatever day of the week it is today.
function reviewsDue(date = new Date()) {
  const lastWeekDay = new Date(date);
  lastWeekDay.setDate(lastWeekDay.getDate() - 7);
  const { year, week } = isoWeek(lastWeekDay);
  const weeklyId = `${year}-W${pad(week)}`;
  const weeklyFile = path.join(VAULT_PATH, 'Resources', 'weekly', `${weeklyId}.md`);

  const lastMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const monthlyId = `${lastMonth.getFullYear()}-${pad(lastMonth.getMonth() + 1)}`;
  const monthlyFile = path.join(VAULT_PATH, 'Resources', 'monthly', `${monthlyId}.md`);

  return {
    weekly: { id: weeklyId, due: !fs.existsSync(weeklyFile) },
    monthly: { id: monthlyId, due: !fs.existsSync(monthlyFile) },
  };
}

// Today + the next few days from Google Calendar, via the vault's own gcal
// helper (`.claude/skills/gcal/gcal.py agenda`) rather than a second
// integration — that script already owns the OAuth, the cache and the config.
// Without --force it reads its own 2h cache, so opening this window repeatedly
// doesn't hammer the network. Never rejects: a missing/unconfigured calendar
// comes back as `{ connected: false }` and the panel shows a quiet line.
function readAgenda() {
  const script = path.join(VAULT_PATH, '.claude', 'skills', 'gcal', 'gcal.py');
  if (!fs.existsSync(script)) return Promise.resolve({ connected: false, days: [] });

  return new Promise((resolve) => {
    execFile(
      'python3',
      [script, 'agenda'],
      { cwd: VAULT_PATH, timeout: 20_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve({ connected: false, days: [] });
        const text = String(stdout || '').trim();
        // gcal.py prints `_No calendar events (or calendar not connected yet)._`
        // for a connected calendar with nothing on it — a sentence that also
        // contains the words "calendar not connected". Match the sentinel as a
        // whole line first, or an empty-but-working calendar reads as a broken
        // integration and the "Nothing scheduled" state can never be reached.
        if (!text || /^_No calendar events/m.test(text)) {
          return resolve({ connected: true, days: [] });
        }
        if (/not connected/i.test(text)) return resolve({ connected: false, days: [] });
        const days = [];
        for (const line of text.split(/\r?\n/)) {
          const h = line.match(/^###\s+(.*)$/);
          if (h) {
            days.push({ label: h[1].trim(), events: [] });
            continue;
          }
          const e = line.match(/^-\s+(?:(\d{1,2}:\d{2})\s+)?\*\*(.*?)\*\*\s*$/);
          if (e && days.length) days[days.length - 1].events.push({ time: e[1] || '', title: e[2] });
        }
        resolve({ connected: true, days: days.filter((d) => d.events.length) });
      }
    );
  });
}

// ---------- Deep-linked notes (rocky://open?file=…) ----------
// Any vault-relative markdown file, read for the Mission Control note page.
// Frontmatter is split off (rendered as a small meta row, not as a table);
// the title comes from frontmatter `title`, else the first H1, else the file
// name. Same in-vault guard as every other path-taking call.
const NOTE_SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.claude']);

function inVault(rel) {
  const abs = path.resolve(VAULT_PATH, String(rel || ''));
  const root = path.resolve(VAULT_PATH);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function splitFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].trim() === '' ? [] : kv[2].trim();
    } else if (key && /^\s*-\s+/.test(line) && Array.isArray(meta[key])) {
      meta[key].push(line.replace(/^\s*-\s+/, '').trim());
    }
  }
  return { meta, body: content.slice(m[0].length) };
}

function readNote(rel) {
  const abs = inVault(rel);
  if (!abs) return { ok: false, error: 'outside the vault' };
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'no such note' : e.message };
  }
  const { meta, body } = splitFrontmatter(content);
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title =
    (typeof meta.title === 'string' && meta.title.replace(/^["']|["']$/g, '')) ||
    (h1 && h1[1].trim()) ||
    path.basename(abs, '.md');
  let mtime = null;
  try {
    mtime = fs.statSync(abs).mtime.toISOString();
  } catch {
    /* non-fatal */
  }
  return {
    ok: true,
    file: abs,
    rel: path.relative(VAULT_PATH, abs).split(path.sep).join('/'),
    title,
    meta,
    md: body,
    mtime,
  };
}

// [[wikilink]] targets are note names, not paths — Obsidian resolves them by
// basename anywhere in the vault. One walk of the tree, cached for a minute.
let noteIndex = null; // Map<lowercased basename without .md, rel path[]>
let noteIndexAt = 0;
const NOTE_INDEX_TTL_MS = 60_000;

function buildNoteIndex() {
  const idx = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.isDirectory()) continue;
      if (NOTE_SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.md$/i.test(ent.name)) {
        const rel = path.relative(VAULT_PATH, abs).split(path.sep).join('/');
        const key = ent.name.replace(/\.md$/i, '').toLowerCase();
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(rel);
      }
    }
  };
  walk(VAULT_PATH);
  return idx;
}

function resolveWikilink(target) {
  let t = String(target || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!t) return null;
  // A path-shaped target ("Areas/Health", "Projects/X/Y.md") wins outright.
  const direct = inVault(/\.md$/i.test(t) ? t : `${t}.md`);
  if (direct && fs.existsSync(direct)) return path.relative(VAULT_PATH, direct).split(path.sep).join('/');
  if (!noteIndex || Date.now() - noteIndexAt > NOTE_INDEX_TTL_MS) {
    noteIndex = buildNoteIndex();
    noteIndexAt = Date.now();
  }
  const hits = noteIndex.get(path.posix.basename(t).replace(/\.md$/i, '').toLowerCase());
  if (!hits || !hits.length) return null;
  // Same ambiguity rule as Obsidian: shortest path wins.
  return hits.slice().sort((a, b) => a.length - b.length)[0];
}

module.exports = {
  readNote,
  resolveWikilink,
  appendNote,
  readTodayNotes,
  listTodayTasks,
  listLifeThreads,
  readInbox,
  readHealth,
  reviewsDue,
  readAgenda,
  appendPomodoroSession,
  dailyNotePath,
  todayStamp,
  listTasks,
  toggleTaskLine,
  listProjects,
  listProjectsBrief,
  getCigCount,
  logCigarette,
  saveArticleNote,
  readArticleDraft,
  saveArticleDraft,
  clearArticleDraft,
  readSessionNotes,
  saveSessionNotes,
  hasSessionNotes,
  listSessionTaskItems,
};
