// Rocky OS — Mission Control renderer · Glass Cockpit.
//
// The board is spatially fixed: DAY tape left, SYSTEMS rail right, mini
// instruments under the center display. Only the center display ever changes —
// it swaps "pages" in place (Now / Day / Threads / Projects / Inbox / Health /
// a job's log), so glancing never costs layout and prose is one swap away.
//
// Data flow is unchanged from v1: state panels are pull-only reads of the vault
// (open, focus, ⟳ — plus a debounced reload when a Rocky job finishes, since a
// finished job has usually just written the vault), and the agent side is
// push-only job/session events. Nothing polls while idle; the only timer is a
// 30s clock tick and a 1s elapsed ticker that exists only while a job runs.

// ======================= markdown-lite =======================
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, p, alias) => alias || p.split('/').pop());
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1');
  return s;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setEmpty(container, message) {
  container.innerHTML = '';
  container.appendChild(el('div', 'empty', message));
}

function setError(container, e) {
  container.innerHTML = '';
  container.appendChild(el('div', 'error', `Couldn't load — ${(e && e.message) || e}`));
}

async function safely(container, label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`[mission-control] ${label} failed`, e);
    if (container) setError(container, e);
  }
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

// One icon system, one stroke weight — drawn, not typed.
const ICONS = {
  refresh:
    '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12.3 7a5.3 5.3 0 1 1-1.6-3.8"/><path d="M12.5 1.5v2.7h-2.7"/></svg>',
  back:
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2 4 6l3.5 4"/></svg>',
  stop:
    '<svg width="8" height="8" viewBox="0 0 8 8"><rect width="8" height="8" rx="1" fill="currentColor"/></svg>',
  check:
    '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5.5 4 8l4.5-6"/></svg>',
  chevrons:
    '<svg class="fd-chevrons" width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5 5.5 5l-4 3.5"/><path d="M7.5 1.5 11.5 5l-4 3.5"/></svg>',
};

// ======================= cached vault state =======================
// Pages render from this cache; loaders fill it and repaint whatever region
// (tape, instrument, open page) shows that system.
const state = {
  tasks: [],
  agenda: null,
  threads: [],
  projects: [],
  inbox: null,
  health: null,
};

// ======================= FMA strip =======================
const fmaRocky = document.getElementById('fma-rocky-value');
const fmaDay = document.getElementById('fma-day-value');
const fmaTerm = document.getElementById('fma-term-value');

function flash(node) {
  node.classList.remove('flash');
  void node.offsetWidth; // restart the finite animation
  node.classList.add('flash');
  node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
}

function renderClock() {
  const now = new Date();
  document.getElementById('fma-date').textContent = now
    .toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })
    .toUpperCase();
  document.getElementById('fma-time').textContent = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
setInterval(renderClock, 30_000);

function updateFmaRocky() {
  const running = [...jobState.values()].filter((j) => j.state === 'running').length;
  const engaged = running > 0;
  const text = engaged ? `${running} ENG` : 'STBY';
  if (fmaRocky.textContent !== text) {
    fmaRocky.textContent = text;
    fmaRocky.classList.toggle('mode-eng', engaged);
    fmaRocky.classList.toggle('mode-stby', !engaged);
    flash(fmaRocky);
  }
  updateModeKeys();
}

function updateFmaDay() {
  const done = state.tasks.filter((t) => t.checked).length;
  fmaDay.textContent = state.tasks.length ? `${done}/${state.tasks.length}` : '—';
}

async function loadAnnunciators() {
  const wrap = document.getElementById('annunciators');
  await safely(null, 'reviews-due', async () => {
    const due = await window.brain.reviewsDue();
    wrap.innerHTML = '';
    if (due.weekly && due.weekly.due) {
      const b = el('button', 'annunciator', `WK REVIEW DUE · ${due.weekly.id}`);
      b.addEventListener('click', () => prefill('/weekly-review'));
      wrap.appendChild(b);
    }
    if (due.monthly && due.monthly.due) {
      const b = el('button', 'annunciator', `MO REVIEW DUE · ${due.monthly.id}`);
      b.addEventListener('click', () => prefill('/monthly-review'));
      wrap.appendChild(b);
    }
  });
}

// ======================= CDU scratchpad =======================
const cmdInput = document.getElementById('cmd');
const cmdStatus = document.getElementById('cmd-status');

const QUICK_ACTIONS = [
  { label: 'Start Day', command: '/start-day' },
  { label: 'End of Day', command: '/end-of-day' },
  { label: 'Process Inbox', command: '/process-inbox' },
  { label: 'Save Session', command: '/save' },
  { label: 'Weekly Review', command: '/weekly-review' },
];

function prefill(text) {
  cmdInput.value = text;
  cmdInput.focus();
  cmdInput.setSelectionRange(text.length, text.length);
  syncSendArmed();
}

function errText(e) {
  const raw = (e && e.message) || String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

function status(text, isError) {
  cmdStatus.textContent = text || '';
  cmdStatus.classList.toggle('err', !!isError);
}

function renderModeKeys() {
  const wrap = document.getElementById('quick');
  for (const action of QUICK_ACTIONS) {
    const b = el('button', 'modekey');
    b.dataset.label = action.label;
    b.appendChild(el('span', 'key-light'));
    b.appendChild(document.createTextNode(action.label));
    b.title = `Dispatch ${action.command} to Rocky in the vault`;
    b.addEventListener('click', () => dispatch(action.command, action.label));
    wrap.appendChild(b);
  }
}

// A mode key lights green while its job runs — like an engaged autopilot mode.
function updateModeKeys() {
  const runningLabels = new Set(
    [...jobState.values()].filter((j) => j.state === 'running').map((j) => j.label),
  );
  for (const key of document.querySelectorAll('.modekey')) {
    key.classList.toggle('engaged', runningLabels.has(key.dataset.label));
  }
}

async function dispatch(prompt, label) {
  const text = String(prompt || '').trim();
  if (!text) return;
  status('Dispatching…');
  try {
    const job = await window.brain.dispatchJob(text, label || null);
    upsertJob(job);
    showPage(`job:${job.id}`);
    status(`Dispatched ${label || 'job'}`);
    if (!label) cmdInput.value = '';
    syncSendArmed();
  } catch (e) {
    status(errText(e), true);
  }
}

async function dispatchToTerminal(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return;
  try {
    await window.brain.dispatchInTerminal(text);
    status('Opened in Terminal');
    cmdInput.value = '';
    syncSendArmed();
  } catch (e) {
    status(errText(e), true);
  }
}

cmdInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (e.metaKey || e.ctrlKey) dispatchToTerminal(cmdInput.value);
  else dispatch(cmdInput.value);
});
const cmdSend = document.getElementById('cmd-send');
cmdSend.addEventListener('click', () => dispatch(cmdInput.value));
function syncSendArmed() {
  cmdSend.classList.toggle('armed', !!cmdInput.value.trim());
}
cmdInput.addEventListener('input', syncSendArmed);

// ======================= center display pages =======================
const displayTitle = document.getElementById('display-title');
const displayBody = document.getElementById('display-body');
const displayBack = document.getElementById('display-back');
displayBack.innerHTML = ICONS.back;

const PAGE_TITLES = {
  now: 'Now',
  day: 'Day',
  threads: 'Life Threads',
  projects: 'Projects',
  inbox: 'Inbox',
  health: 'Health',
};

let currentPage = 'now';
let jobLogEl = null; // live log element while a job page is open
let jobLogLen = 0;

function showPage(page) {
  currentPage = page;
  jobLogEl = null;
  const isJob = page.startsWith('job:');
  displayTitle.textContent = isJob ? 'Rocky Job' : PAGE_TITLES[page] || 'Now';
  displayBack.hidden = page === 'now';
  for (const key of ['threads', 'projects', 'inbox', 'health']) {
    document.getElementById(`instr-${key}`).classList.toggle('active', page === key);
  }
  displayBody.innerHTML = '';
  displayBody.scrollTop = 0;
  if (isJob) renderJobPage(page.slice(4));
  else if (page === 'day') renderDayPage();
  else if (page === 'threads') renderThreadsPage();
  else if (page === 'projects') renderProjectsPage();
  else if (page === 'inbox') renderInboxPage();
  else if (page === 'health') renderHealthPage();
  else renderNowPage();
}

displayBack.addEventListener('click', () => showPage('now'));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || currentPage === 'now') return;
  if (document.activeElement === cmdInput && cmdInput.value) return;
  showPage('now');
});

function repaintIfCurrent(page) {
  if (currentPage === page) showPage(page);
}

// ---------- NOW ----------
function firstOpenTask() {
  return state.tasks.find((t) => !t.checked) || null;
}

function upcomingEvents(limit) {
  const out = [];
  if (!state.agenda || !state.agenda.connected) return out;
  for (const day of state.agenda.days) {
    for (const ev of day.events) out.push({ day: day.label, time: ev.time, title: ev.title });
  }
  return out.slice(0, limit);
}

function renderNowPage() {
  const wrap = displayBody;

  const label = el('div', 'now-label');
  label.innerHTML = `${ICONS.chevrons}<span>Next action</span>`;
  wrap.appendChild(label);

  const task = firstOpenTask();
  if (task) {
    const t = el('p', 'now-task');
    t.innerHTML = renderInline(task.text);
    t.title = 'Open the full task list';
    t.addEventListener('click', () => showPage('day'));
    wrap.appendChild(t);
    const open = state.tasks.filter((x) => !x.checked).length;
    const rest = el('div', 'now-rest');
    rest.innerHTML =
      open > 1 ? `then <b>${open - 1}</b> more on the Day tape` : 'last one — the tape is nearly clear';
    wrap.appendChild(rest);
  } else if (state.tasks.length) {
    wrap.appendChild(el('p', 'now-clear', 'Day complete — every task checked.'));
  } else {
    wrap.appendChild(el('p', 'now-clear', 'No flight plan yet.'));
    wrap.appendChild(el('div', 'now-rest', 'Start Day builds today’s note and its task list.'));
  }

  const events = upcomingEvents(3);
  if (events.length) {
    const block = el('div', 'now-wpt-block');
    block.appendChild(el('div', 'now-label', 'Waypoints'));
    events.forEach((ev, i) => {
      const row = el('div', 'now-wpt' + (i === 0 ? '' : ' later'));
      row.appendChild(el('span', 'now-wpt-time', ev.time || 'all day'));
      const t = el('span', 'now-wpt-title');
      t.innerHTML = `${renderInline(ev.title)}`;
      if (i > 0 || !/today/i.test(ev.day)) t.innerHTML += ` <span class="wpt-daytag">· ${escapeHtml(ev.day)}</span>`;
      row.appendChild(t);
      block.appendChild(row);
    });
    wrap.appendChild(block);
  }
}

// ---------- DAY (full prose) ----------
let toggleBusy = false;

async function toggleTask(item, box) {
  if (toggleBusy) return;
  toggleBusy = true;
  box.classList.add('busy');
  try {
    await window.brain.toggleTask({ file: item.file, line: item.line, raw: item.raw });
    await loadToday();
  } catch (e) {
    box.classList.remove('busy');
    status(`Could not update that task — ${errText(e)}`, true);
  } finally {
    toggleBusy = false;
  }
}

function renderDayPage() {
  const wrap = displayBody;
  if (!state.tasks.length) {
    setEmpty(wrap, "No tasks in today's note yet — Start Day builds it.");
  } else {
    let group = null;
    for (const item of state.tasks) {
      if (item.group !== group) {
        group = item.group;
        if (group) wrap.appendChild(el('div', 'group-label', group));
      }
      const row = el('div', 'item' + (item.checked ? ' checked' : ''));
      const box = el('div', 'item-check');
      box.innerHTML = ICONS.check;
      const txt = el('div', 'item-text');
      txt.innerHTML = renderInline(item.text);
      row.appendChild(box);
      row.appendChild(txt);
      row.addEventListener('click', () => {
        const selection = window.getSelection();
        if (selection && String(selection).trim()) return;
        toggleTask(item, box);
      });
      wrap.appendChild(row);
    }
  }
  if (state.agenda && state.agenda.connected && state.agenda.days.length) {
    wrap.appendChild(el('div', 'page-sub', 'Waypoints'));
    for (const day of state.agenda.days) {
      wrap.appendChild(el('div', 'wpt-day', day.label));
      for (const ev of day.events) {
        const row = el('div', 'wpt');
        row.appendChild(el('span', 'wpt-time', ev.time || 'all day'));
        const t = el('span', 'wpt-title');
        t.style.whiteSpace = 'normal';
        t.innerHTML = renderInline(ev.title);
        row.appendChild(t);
        wrap.appendChild(row);
      }
    }
  }
}

// ---------- THREADS / PROJECTS / INBOX / HEALTH pages ----------
function renderThreadsPage() {
  const wrap = displayBody;
  const active = state.threads.filter((t) => /active/i.test(t.section));
  if (!active.length) {
    setEmpty(wrap, state.threads.length ? 'No active threads.' : 'Life-Threads.md not found.');
    return;
  }
  for (const thread of active) {
    const div = el('div', 'thread');
    div.appendChild(el('div', 'thread-name', thread.name));
    for (const [key, value, cls] of [
      ['Latest', thread.latest, ''],
      ['Next', thread.next, 'next'],
    ]) {
      if (!value) continue;
      const row = el('div', 'thread-field');
      row.appendChild(el('span', 'thread-key', key));
      const val = el('span', `thread-val ${cls}`.trim());
      val.innerHTML = renderInline(value);
      row.appendChild(val);
      div.appendChild(row);
    }
    wrap.appendChild(div);
  }
  const rest = state.threads.length - active.length;
  if (rest) wrap.appendChild(el('div', 'empty', `+${rest} simmering / dormant threads live in the vault note.`));
}

function renderProjectsPage() {
  const wrap = displayBody;
  if (!state.projects.length) {
    setEmpty(wrap, 'No project registry found.');
    return;
  }
  for (const p of state.projects) {
    const div = el('div', 'proj');
    const name = el('div', 'proj-name');
    const label = el('span');
    label.innerHTML = renderInline(p.name);
    name.appendChild(label);
    if (/✅/.test(p.graph || '')) name.appendChild(el('span', 'proj-graph', 'GRAPH'));
    div.appendChild(name);
    const st = el('div', 'proj-status');
    st.innerHTML = renderInline(p.status);
    div.appendChild(st);
    div.title = p.path || '';
    wrap.appendChild(div);
  }
}

function renderInboxPage() {
  const wrap = displayBody;
  if (!state.inbox || !state.inbox.total) {
    setEmpty(wrap, 'Inbox clear.');
    return;
  }
  for (const item of state.inbox.items) {
    const div = el('div', 'inbox-item');
    div.appendChild(el('div', 'inbox-name', item.name));
    if (item.source) div.appendChild(el('div', 'inbox-src', item.source));
    wrap.appendChild(div);
  }
  if (state.inbox.mobile) {
    const b = el('button', 'modekey', `Route ${state.inbox.mobile} phone capture${state.inbox.mobile === 1 ? '' : 's'}`);
    b.classList.add('page-action');
    b.addEventListener('click', () => dispatch('/process-inbox', 'Process Inbox'));
    wrap.appendChild(b);
  }
}

function renderHealthPage() {
  const wrap = displayBody;
  if (!state.health || !state.health.rows.length) {
    setEmpty(wrap, 'No trend log rows.');
    return;
  }
  for (const row of state.health.rows) {
    const div = el('div', 'health-row');
    div.appendChild(el('span', 'health-date', row.date));
    const parts = [];
    for (let i = 1; i < state.health.columns.length - 1; i++) {
      const value = (row.cells[i] || '').trim();
      if (!value || value === '—' || value === '-') continue;
      const icon = (state.health.columns[i] || '').split(' ')[0];
      parts.push(`${icon} ${value}`);
    }
    div.appendChild(el('span', 'health-vals', parts.join(' · ') || '—'));
    div.title = row.cells[row.cells.length - 1] || '';
    wrap.appendChild(div);
  }
}

// ---------- JOB page (live log) ----------
function renderJobPage(id) {
  const job = jobState.get(id);
  const wrap = displayBody;
  if (!job) {
    setEmpty(wrap, 'Job not found — it may predate this window.');
    return;
  }
  const head = el('div', 'jobpage-head');
  head.appendChild(el('div', 'jobpage-title', jobTitle(job)));
  const meta = el('span', 'jobpage-meta', jobMetaText(job));
  head.appendChild(meta);
  if (job.state === 'running') {
    const stop = el('button', 'jobpage-stop', job.stopping ? 'FORCE' : 'STOP');
    stop.addEventListener('click', () => window.brain.killJob(id).catch(() => {}));
    head.appendChild(stop);
  }
  wrap.appendChild(head);
  const log = el('pre', 'job-log');
  log.textContent = job.output || '';
  wrap.appendChild(log);
  jobLogEl = log;
  jobLogLen = (job.output || '').length;
  log.scrollTop = log.scrollHeight;
}

// ======================= mini instruments =======================
document.getElementById('instr-threads').addEventListener('click', () => showPage(currentPage === 'threads' ? 'now' : 'threads'));
document.getElementById('instr-projects').addEventListener('click', () => showPage(currentPage === 'projects' ? 'now' : 'projects'));
document.getElementById('instr-inbox').addEventListener('click', () => showPage(currentPage === 'inbox' ? 'now' : 'inbox'));
document.getElementById('instr-health').addEventListener('click', () => showPage(currentPage === 'health' ? 'now' : 'health'));

function plainText(md) {
  return String(md || '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, p, alias) => alias || p.split('/').pop())
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function paintThreadsInstrument() {
  const active = state.threads.filter((t) => /active/i.test(t.section));
  document.getElementById('instr-threads-value').textContent = active.length || '—';
  const next = active.find((t) => t.next);
  document.getElementById('instr-threads-note').textContent = next ? plainText(next.next) : '';
}

function paintProjectsInstrument() {
  document.getElementById('instr-projects-value').textContent = state.projects.length || '—';
  const withGraph = state.projects.filter((p) => /✅/.test(p.graph || '')).length;
  document.getElementById('instr-projects-note').textContent = withGraph ? `${withGraph} graphed` : '';
}

function paintInboxInstrument() {
  const value = document.getElementById('instr-inbox-value');
  const note = document.getElementById('instr-inbox-note');
  const total = state.inbox ? state.inbox.total : 0;
  const mobile = state.inbox ? state.inbox.mobile : 0;
  value.textContent = total;
  value.classList.toggle('caution', mobile > 0);
  note.classList.toggle('caution', mobile > 0);
  note.textContent = mobile ? `${mobile} unrouted capture${mobile === 1 ? '' : 's'}` : total ? 'nothing mobile' : 'clear';
}

// Trend instrument: the first numeric health column (cigarettes) over the last
// two weeks, oldest → newest, drawn as one engraved line.
function paintHealthInstrument() {
  const spark = document.getElementById('instr-health-spark');
  const note = document.getElementById('instr-health-note');
  const logged = state.health && state.health.loggedToday;
  note.textContent = logged ? 'logged today' : 'not logged today';
  note.classList.toggle('caution', !logged);
  const rows = state.health ? state.health.rows.slice(0, 14) : [];
  const values = rows
    .map((r) => parseFloat((r.cells[1] || '').replace(',', '.')))
    .filter((v) => Number.isFinite(v))
    .reverse();
  if (values.length < 2) {
    spark.innerHTML = '<span class="instr-value">—</span>';
    return;
  }
  const w = 64;
  const h = 16;
  const max = Math.max(...values, 1);
  const inner = w - 6; // keep the end dot's radius inside the frame
  const step = inner / (values.length - 1);
  const pts = values.map((v, i) => `${(3 + i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  spark.innerHTML =
    `<svg width="${w}" height="${h + 3}" viewBox="0 0 ${w} ${h + 3}" fill="none">` +
    `<polyline points="${pts.join(' ')}" style="stroke:var(--dim)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${3 + inner}" cy="${pts[pts.length - 1].split(',')[1]}" r="2.5" style="fill:var(${logged ? '--grn' : '--amb'})"/>` +
    '</svg>';
}

// ======================= DAY tape =======================
function renderTape() {
  const wrap = document.getElementById('tape-tasks');
  const open = state.tasks.filter((t) => !t.checked).length;
  document.getElementById('tasks-note').textContent = state.tasks.length
    ? `${state.tasks.length - open} done · ${open} open`
    : '';
  updateFmaDay();

  if (!state.tasks.length) {
    setEmpty(wrap, 'No flight plan yet — Start Day builds it.');
    return;
  }
  wrap.innerHTML = '';
  const commanded = firstOpenTask();
  let group = null;
  for (const item of state.tasks) {
    if (item.group !== group) {
      group = item.group;
      if (group) wrap.appendChild(el('div', 'tick-group', group));
    }
    const row = el('div', 'tick' + (item.checked ? ' done' : '') + (item === commanded ? ' commanded' : ''));
    const box = el('button', 'tick-box');
    box.innerHTML = item.checked ? ICONS.check : '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="8" height="8" rx="1"/></svg>';
    box.title = item.checked ? 'Un-check' : 'Check off';
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTask(item, box);
    });
    const label = el('button', 'tick-label');
    label.innerHTML = renderInline(item.text);
    label.title = 'Open the full task list';
    label.addEventListener('click', () => showPage('day'));
    row.appendChild(box);
    row.appendChild(label);
    wrap.appendChild(row);
  }
}

function renderTapeAgenda() {
  const wrap = document.getElementById('tape-agenda');
  if (!state.agenda) return;
  if (!state.agenda.connected) {
    setEmpty(wrap, 'Calendar not connected.');
    return;
  }
  if (!state.agenda.days.length) {
    setEmpty(wrap, 'Nothing scheduled.');
    return;
  }
  wrap.innerHTML = '';
  for (const day of state.agenda.days) {
    wrap.appendChild(el('div', 'wpt-day', day.label));
    for (const ev of day.events) {
      const row = el('div', 'wpt');
      row.appendChild(el('span', 'wpt-time', ev.time || 'all day'));
      const t = el('span', 'wpt-title', '');
      t.innerHTML = renderInline(ev.title);
      t.title = ev.title;
      row.appendChild(t);
      wrap.appendChild(row);
    }
  }
}

// ======================= loaders =======================
async function loadToday() {
  await safely(document.getElementById('tape-tasks'), 'today', async () => {
    state.tasks = await window.brain.todayTasks();
    renderTape();
    if (currentPage === 'now' || currentPage === 'day') repaintIfCurrent(currentPage);
  });
}

async function loadAgenda() {
  await safely(document.getElementById('tape-agenda'), 'agenda', async () => {
    state.agenda = await window.brain.agenda();
    renderTapeAgenda();
    if (currentPage === 'now' || currentPage === 'day') repaintIfCurrent(currentPage);
  });
}

async function loadThreads() {
  await safely(null, 'life-threads', async () => {
    state.threads = await window.brain.lifeThreads();
    paintThreadsInstrument();
    repaintIfCurrent('threads');
  });
}

async function loadProjects() {
  await safely(null, 'projects', async () => {
    state.projects = await window.brain.projectsBrief();
    paintProjectsInstrument();
    repaintIfCurrent('projects');
  });
}

async function loadInbox() {
  await safely(null, 'inbox', async () => {
    state.inbox = await window.brain.inbox();
    paintInboxInstrument();
    repaintIfCurrent('inbox');
  });
}

async function loadHealth() {
  await safely(null, 'health', async () => {
    state.health = await window.brain.health();
    paintHealthInstrument();
    repaintIfCurrent('health');
  });
}

// ======================= SYSTEMS rail: jobs =======================
const railEls = new Map(); // id -> { root, name, meta, stop }
const jobState = new Map(); // id -> last snapshot (with output)
let tickTimer = null;
const MAX_LOG_CHARS = 60_000;

function jobTitle(job) {
  if (job.label) return job.label;
  return String(job.prompt || '').split('\n')[0].slice(0, 90);
}

function jobMetaText(job) {
  const end = job.state === 'running' ? Date.now() : job.endedAt || job.startedAt;
  const elapsed = fmtDuration(end - job.startedAt);
  if (job.stopping) return `stopping · ${elapsed}`;
  if (job.state === 'running') return elapsed;
  if (job.state === 'killed') return `stopped · ${elapsed}`;
  if (job.state === 'failed') return `failed${job.exitCode == null ? '' : ` (${job.exitCode})`} · ${elapsed}`;
  return `done · ${elapsed}`;
}

function buildRailJob(job) {
  const root = el('div', 'rail-job');
  root.dataset.id = job.id;
  root.appendChild(el('span', 'rail-light'));
  const name = el('button', 'rail-name', jobTitle(job));
  name.title = 'Open this job’s log';
  name.addEventListener('click', () => showPage(`job:${job.id}`));
  root.appendChild(name);
  const meta = el('span', 'rail-meta');
  root.appendChild(meta);
  const stop = el('button', 'rail-stop');
  stop.innerHTML = ICONS.stop;
  stop.title = 'Stop this job';
  stop.addEventListener('click', () => window.brain.killJob(job.id).catch(() => {}));
  root.appendChild(stop);
  return { root, name, meta, stop };
}

function paintRailJob(job) {
  const parts = railEls.get(job.id);
  if (!parts) return;
  parts.root.classList.remove('running', 'done', 'failed', 'killed');
  parts.root.classList.add(job.state);
  parts.meta.textContent = jobMetaText(job);
  parts.stop.style.display = job.state === 'running' ? '' : 'none';
}

// A finished job has usually just written the vault — reload the state side
// once, debounced, so the board tells the truth without a manual ⟳.
let vaultReloadTimer = null;
function scheduleVaultReload() {
  clearTimeout(vaultReloadTimer);
  vaultReloadTimer = setTimeout(() => {
    loadToday();
    loadAgenda();
    loadInbox();
    loadThreads();
    loadHealth();
    loadAnnunciators();
  }, 1200);
}

function upsertJob(job) {
  const prev = jobState.get(job.id);
  jobState.set(job.id, { ...(prev || {}), ...job });
  const merged = jobState.get(job.id);
  const container = document.getElementById('rail-jobs');

  let parts = railEls.get(job.id);
  if (!parts) {
    parts = buildRailJob(merged);
    railEls.set(job.id, parts);
    const placeholder = container.querySelector('.empty');
    if (placeholder) placeholder.remove();
    container.prepend(parts.root);
  }
  paintRailJob(merged);

  const stateChanged = prev && prev.state !== merged.state;
  if (stateChanged) {
    flash(parts.root);
    parts.root.classList.add('flash');
    if (merged.state !== 'running') scheduleVaultReload();
  }
  if (currentPage === `job:${job.id}` && (stateChanged || !jobLogEl)) repaintIfCurrent(currentPage);

  updateFmaRocky();
  syncTicker();
}

function appendJobOutput({ id, chunk }) {
  const snap = jobState.get(id);
  if (snap) {
    snap.output = (snap.output || '') + chunk;
    if (snap.output.length > MAX_LOG_CHARS * 2) snap.output = snap.output.slice(-MAX_LOG_CHARS);
  }
  if (currentPage !== `job:${id}` || !jobLogEl) return;
  const nearBottom = jobLogEl.scrollHeight - jobLogEl.scrollTop - jobLogEl.clientHeight < 40;
  jobLogEl.appendChild(document.createTextNode(chunk));
  jobLogLen += chunk.length;
  if (jobLogLen > MAX_LOG_CHARS * 2) {
    const kept = jobLogEl.textContent.slice(-MAX_LOG_CHARS);
    jobLogEl.textContent = kept;
    jobLogLen = kept.length;
  }
  if (nearBottom) jobLogEl.scrollTop = jobLogEl.scrollHeight;
}

// 1s elapsed tick — exists only while a job is actually running.
function syncTicker() {
  const anyRunning = [...jobState.values()].some((j) => j.state === 'running');
  if (anyRunning && !tickTimer) {
    tickTimer = setInterval(() => {
      for (const job of jobState.values()) {
        if (job.state !== 'running') continue;
        paintRailJob(job);
        if (currentPage === `job:${job.id}`) {
          const meta = displayBody.querySelector('.jobpage-meta');
          if (meta) meta.textContent = jobMetaText(job);
        }
      }
    }, 1000);
  } else if (!anyRunning && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function loadJobs() {
  const container = document.getElementById('rail-jobs');
  await safely(container, 'jobs', async () => {
    container.innerHTML = '';
    railEls.clear();
    jobState.clear();
    const jobs = await window.brain.listJobs();
    if (!jobs.length) {
      setEmpty(container, 'No jobs yet — dispatch one below.');
      updateFmaRocky();
      syncTicker();
      return;
    }
    for (const job of [...jobs].reverse()) upsertJob(job);
  });
}

window.brain.onJobUpdate((job) => upsertJob(job));
window.brain.onJobOutput((payload) => appendJobOutput(payload));

// ======================= SYSTEMS rail: terminals =======================
function renderSessions(list) {
  fmaTerm.textContent = String(list.length);
  document.getElementById('sys-note').textContent = '';
  const container = document.getElementById('rail-sessions');
  container.innerHTML = '';
  if (!list.length) {
    setEmpty(container, 'No Claude terminals running.');
    return;
  }
  for (const s of list) {
    const div = el('div', 'sess');
    const head = el('div', 'sess-head');
    head.appendChild(el('span', 'sess-dot'));
    head.appendChild(el('span', 'sess-name', s.name));
    if (s.hasNotes) head.appendChild(el('span', 'sess-notes', 'NOTES'));
    div.appendChild(head);
    div.appendChild(el('div', 'sess-meta', `pid ${s.pid} · ${s.tty} · ${s.etime}`));
    div.title = s.cwd;
    container.appendChild(div);
  }
}

async function loadSessions() {
  const container = document.getElementById('rail-sessions');
  await safely(container, 'sessions', async () => {
    renderSessions(await window.brain.listSessions());
  });
}

window.brain.onSessionsUpdate((list) => renderSessions(list));

// ======================= init =======================
document.getElementById('refresh').innerHTML = ICONS.refresh;
document.getElementById('tasks-head').addEventListener('click', () => showPage(currentPage === 'day' ? 'now' : 'day'));

function refreshAll() {
  renderClock();
  loadAnnunciators();
  loadToday();
  loadAgenda();
  loadThreads();
  loadProjects();
  loadInbox();
  loadHealth();
  loadSessions();
}

document.getElementById('refresh').addEventListener('click', refreshAll);

window.addEventListener('focus', () => {
  renderClock();
  loadToday();
  loadInbox();
  loadAnnunciators();
});

renderModeKeys();
showPage('now');
refreshAll();
loadJobs();
