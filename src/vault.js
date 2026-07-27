// Vault read/write helpers. The main process owns all filesystem access;
// the renderer only talks to these via IPC (see main.js + preload.js).
const fs = require('fs');
const path = require('path');
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
// Tasks / Reading dashboard: aggregate `## Tasks` checkboxes across the last
// N days of Daily notes, and write toggles back to the exact source line.
// ---------------------------------------------------------------------------

const TASKS_HEADING = '## Tasks';

// Body of a `## heading` section: from just after the heading line up to
// (not including) the next `## ` heading, or end of file.
function sectionBody(content, heading) {
  const idx = content.indexOf(heading);
  if (idx === -1) return null;
  const start = content.indexOf('\n', idx) + 1;
  const rest = content.slice(start);
  const nextHeading = rest.search(/\n## /);
  const bodyEnd = nextHeading === -1 ? rest.length : nextHeading + 1;
  return { start, body: rest.slice(0, bodyEnd) };
}

function parseCheckboxLines(body) {
  const lines = body.split('\n');
  const items = [];
  lines.forEach((line, i) => {
    const m = line.match(/^- \[([ xX])\]\s+(.*)$/);
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

// Flip `- [ ]` <-> `- [x]` on one line of one file. `line`/`raw` come from
// listTasks() and are used to re-locate the exact line even if earlier lines
// in the file shifted; falls back to an exact-text search if the file changed.
function toggleTaskLine(file, line, raw) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let at = line;
  if (lines[at] !== raw) {
    at = lines.indexOf(raw);
    if (at === -1) throw new Error('That task line no longer matches the note — it may have changed.');
  }
  const toggled = /^- \[ \]/.test(raw)
    ? raw.replace('- [ ]', '- [x]')
    : raw.replace(/^- \[[xX]\]/, '- [ ]');
  lines[at] = toggled;
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
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

module.exports = {
  appendNote,
  readTodayNotes,
  appendPomodoroSession,
  dailyNotePath,
  todayStamp,
  listTasks,
  toggleTaskLine,
  listProjects,
};
