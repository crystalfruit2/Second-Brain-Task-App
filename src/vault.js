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

module.exports = { appendNote, readTodayNotes, dailyNotePath, todayStamp };
