// ======================= tiny markdown-lite renderer =======================
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text) {
  let s = escapeHtml(String(text || ''));
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, p, alias) => alias || p.split('/').pop());
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1');
  return s;
}

function pad(n) { return String(n).padStart(2, '0'); }
function todayStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateLabel(dateStr) {
  if (dateStr === todayStamp()) return 'Today';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (dateStr === todayStamp(y)) return 'Yesterday';
  return dateStr;
}

// ======================= tasks / reading =======================
let toggleBusy = false;

function groupByDate(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.date)) map.set(it.date, []);
    map.get(it.date).push(it);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function renderItem(it) {
  const row = document.createElement('div');
  row.className = 'item' + (it.checked ? ' checked' : '');

  const box = document.createElement('div');
  box.className = 'item-check';
  box.textContent = it.checked ? '✓' : '';

  const txt = document.createElement('div');
  txt.className = 'item-text';
  txt.innerHTML = renderInline(it.text);

  row.appendChild(box);
  row.appendChild(txt);
  row.addEventListener('click', () => toggleTask(it));
  return row;
}

function renderItems(container, items) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="empty">Nothing here.</div>';
    return;
  }
  for (const [date, group] of groupByDate(items)) {
    const wrap = document.createElement('div');
    wrap.className = 'date-group';
    const label = document.createElement('div');
    label.className = 'date-label';
    label.textContent = dateLabel(date);
    wrap.appendChild(label);
    const sorted = [...group].sort((a, b) => Number(a.checked) - Number(b.checked));
    for (const it of sorted) wrap.appendChild(renderItem(it));
    container.appendChild(wrap);
  }
}

async function toggleTask(it) {
  if (toggleBusy) return;
  toggleBusy = true;
  try {
    await window.brain.toggleTask({ file: it.file, line: it.line, raw: it.raw });
    await loadTasks();
  } catch (e) {
    alert('Could not update that task — ' + (e && e.message ? e.message : e));
  } finally {
    toggleBusy = false;
  }
}

async function loadTasks() {
  const tasksEl = document.getElementById('list-tasks');
  const readingEl = document.getElementById('list-reading');
  try {
    const items = await window.brain.listTasks();
    const tasks = items.filter((i) => i.kind === 'task');
    const reading = items.filter((i) => i.kind === 'reading');
    document.getElementById('count-tasks').textContent = tasks.filter((t) => !t.checked).length;
    document.getElementById('count-reading').textContent = reading.filter((t) => !t.checked).length;
    renderItems(tasksEl, tasks);
    renderItems(readingEl, reading);
  } catch (e) {
    const msg = `<div class="error">Failed to load: ${escapeHtml(String(e && e.message ? e.message : e))}</div>`;
    tasksEl.innerHTML = msg;
    readingEl.innerHTML = msg;
  }
}

// ======================= projects =======================
function renderProject(p) {
  const div = document.createElement('div');
  div.className = 'proj';

  const name = document.createElement('div');
  name.className = 'proj-name';
  name.innerHTML = renderInline(p.name);

  const status = document.createElement('div');
  status.className = 'proj-status';
  status.innerHTML = renderInline(p.status);

  const pathEl = document.createElement('div');
  pathEl.className = 'proj-path';
  pathEl.innerHTML = renderInline(p.path);

  div.appendChild(name);
  div.appendChild(status);
  div.appendChild(pathEl);
  div.addEventListener('click', () => div.classList.toggle('expanded'));
  return div;
}

async function loadProjects() {
  const el = document.getElementById('list-projects');
  try {
    const projects = await window.brain.listProjects();
    document.getElementById('count-projects').textContent = projects.length;
    el.innerHTML = '';
    if (!projects.length) {
      el.innerHTML = '<div class="empty">No projects found.</div>';
      return;
    }
    for (const p of projects) el.appendChild(renderProject(p));
  } catch (e) {
    el.innerHTML = `<div class="error">Failed to load: ${escapeHtml(String(e && e.message ? e.message : e))}</div>`;
  }
}

// ======================= sessions =======================
// Live-updated by main.js's poller (see sessions:update) while this window is
// open — listTasks()/listProjects() above stay pull-only (cheap fs reads), but
// session detection shells out to ps/lsof so main only does it on a timer and
// pushes results here instead of the renderer polling on its own.
let sessionsById = new Map();
let notesHasContentBySlug = new Set();
let activeSlug = null;
let notesSaveTimer = null;

// The one session the widget's Tasks tab currently follows — clicking a card
// here both opens its notes (below) and pins it as that active session, per
// Alp's ask: "go to the main tasks screen and choose the other terminal's
// job." Loaded once on startup so the Dashboard reflects whatever was already
// pinned from a previous session, not just clicks made in this window.
let pinnedSlug = null;

function renderSession(s) {
  const div = document.createElement('div');
  const hasNotes = notesHasContentBySlug.has(s.slug) || s.hasNotes;
  const isPinned = s.slug === pinnedSlug;
  div.className = 'sess' + (hasNotes ? ' has-notes' : '') + (isPinned ? ' pinned' : '');

  const head = document.createElement('div');
  head.className = 'sess-head';
  const dot = document.createElement('span');
  dot.className = 'sess-dot';
  const name = document.createElement('span');
  name.className = 'sess-name';
  name.innerHTML = renderInline(s.name);
  head.appendChild(dot);
  head.appendChild(name);
  if (isPinned) {
    const badge = document.createElement('span');
    badge.className = 'sess-pinned-badge';
    badge.textContent = '● active in Tasks tab';
    head.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'sess-meta';
  // Same project name can appear on multiple cards when several terminals share
  // a cwd (e.g. everything run out of the vault) — pid/tty/open-time are what's
  // left to tell them apart until you've written something identifying in notes.
  meta.textContent = `pid ${s.pid} · ${s.tty} · open ${s.etime}`;

  const pathEl = document.createElement('div');
  pathEl.className = 'sess-path';
  pathEl.textContent = s.cwd;

  div.appendChild(head);
  div.appendChild(meta);
  div.appendChild(pathEl);
  div.addEventListener('click', async () => {
    pinnedSlug = s.slug;
    try {
      await window.brain.setActiveSession(s.slug, s.name);
    } catch {
      /* non-fatal — notes still open below even if pinning failed */
    }
    document.querySelectorAll('.sess').forEach((el) => el.classList.remove('pinned'));
    div.classList.add('pinned');
    openNotes(s);
  });
  return div;
}

function renderSessions(list) {
  sessionsById = new Map(list.map((s) => [s.slug, s]));
  const el = document.getElementById('list-sessions');
  document.getElementById('count-sessions').textContent = list.length;
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="empty">No active Claude sessions detected.</div>';
    return;
  }
  for (const s of list) el.appendChild(renderSession(s));
}

async function loadPinnedSession() {
  try {
    const active = await window.brain.getActiveSession();
    pinnedSlug = active ? active.slug : null;
  } catch {
    pinnedSlug = null;
  }
}

async function loadSessions() {
  try {
    await loadPinnedSession();
    const list = await window.brain.listSessions();
    renderSessions(list);
  } catch (e) {
    document.getElementById('list-sessions').innerHTML =
      `<div class="error">Failed to load: ${escapeHtml(String(e && e.message ? e.message : e))}</div>`;
  }
}

if (window.brain.onSessionsUpdate) {
  window.brain.onSessionsUpdate((list) => renderSessions(list));
}

// ---- notes overlay ----
const overlay = document.getElementById('notes-overlay');
const notesTitle = document.getElementById('notes-title');
const notesBody = document.getElementById('notes-body');
const notesSaved = document.getElementById('notes-saved');

async function openNotes(session) {
  activeSlug = session.slug;
  notesTitle.textContent = session.name;
  notesBody.value = 'Loading…';
  notesSaved.textContent = '';
  overlay.classList.remove('hidden');
  try {
    const text = await window.brain.getSessionNotes(session.slug);
    if (activeSlug !== session.slug) return; // closed/switched while loading
    notesBody.value = text;
    notesBody.focus();
  } catch (e) {
    notesBody.value = '';
  }
}

function closeNotes() {
  overlay.classList.add('hidden');
  activeSlug = null;
}

async function saveNotesNow() {
  if (!activeSlug) return;
  const session = sessionsById.get(activeSlug);
  const text = notesBody.value;
  try {
    await window.brain.saveSessionNotes({ slug: activeSlug, name: session ? session.name : activeSlug, text });
    if (text.trim()) notesHasContentBySlug.add(activeSlug);
    else notesHasContentBySlug.delete(activeSlug);
    notesSaved.textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    notesSaved.textContent = 'Save failed';
  }
}

notesBody.addEventListener('input', () => {
  notesSaved.textContent = 'Saving…';
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveNotesNow, 600);
});

document.getElementById('notes-close').addEventListener('click', () => {
  clearTimeout(notesSaveTimer);
  saveNotesNow().finally(closeNotes);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
    clearTimeout(notesSaveTimer);
    saveNotesNow().finally(closeNotes);
  }
});

// ======================= init =======================
function refreshAll() {
  loadTasks();
  loadProjects();
  loadSessions();
}

document.getElementById('refresh').addEventListener('click', refreshAll);
refreshAll();
