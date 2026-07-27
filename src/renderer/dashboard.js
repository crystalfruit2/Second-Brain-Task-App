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

// ======================= init =======================
function refreshAll() {
  loadTasks();
  loadProjects();
}

document.getElementById('refresh').addEventListener('click', refreshAll);
refreshAll();
