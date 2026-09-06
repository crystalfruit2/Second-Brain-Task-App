// Rocky OS — Mission Control renderer · first-party Apple grammar.
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
  circle:
    '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7.75" stroke="currentColor" stroke-width="1.5"/></svg>',
  circleCheck:
    '<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="8" fill="currentColor"/><path d="M5.5 9.5 8 12l4.5-6" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
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
  const text = engaged ? `${running} active` : 'Idle';
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
  const wasRead = currentPage.startsWith('read:');
  currentPage = page;
  jobLogEl = null;
  const isJob = page.startsWith('job:');
  const isRead = page.startsWith('read:');
  if (wasRead && !isRead) leaveReadMode();
  displayTitle.textContent = isJob ? 'Rocky Job' : PAGE_TITLES[page] || 'Now';
  displayTitle.classList.toggle('rr-title', isRead);
  displayBack.hidden = page === 'now';
  for (const key of ['threads', 'projects', 'inbox', 'health']) {
    document.getElementById(`instr-${key}`).classList.toggle('active', page === key);
  }
  displayBody.innerHTML = '';
  displayBody.scrollTop = 0;
  displayBody.classList.remove('page-in');
  void displayBody.offsetWidth; // restart the finite page-swap animation
  displayBody.classList.add('page-in');
  if (isRead) enterReadMode(page.slice(5));
  else if (isJob) renderJobPage(page.slice(4));
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
  // The reader owns Esc while in read mode: it closes the "Sor" pill, then the
  // frozen selection — never the page. Leaving read mode is the back button.
  if (currentPage.startsWith('read:')) return readerEscape();
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
  label.innerHTML = `${ICONS.chevrons}<span>Up next</span>`;
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
      open > 1 ? `then <b>${open - 1}</b> more today` : 'last one — today is nearly clear';
    wrap.appendChild(rest);
  } else if (state.tasks.length) {
    wrap.appendChild(el('p', 'now-clear', 'Day complete — every task checked.'));
  } else {
    wrap.appendChild(el('p', 'now-clear', 'No tasks yet.'));
    wrap.appendChild(el('div', 'now-rest', 'Start Day builds today’s note and its task list.'));
  }

  const events = upcomingEvents(3);
  if (events.length) {
    const block = el('div', 'now-wpt-block');
    block.appendChild(el('div', 'now-label', 'Schedule'));
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
    wrap.appendChild(el('div', 'page-sub', 'Schedule'));
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
    const stop = el('button', 'jobpage-stop', job.stopping ? 'Force' : 'Stop');
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
    setEmpty(wrap, 'No tasks yet — Start Day builds today’s list.');
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
    box.innerHTML = item.checked ? ICONS.circleCheck : ICONS.circle;
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

// Reading Room side threads are jobs too, but they belong to the inspector,
// not the Rocky rail or the header count.
function isReaderJob(job) {
  return typeof job.label === 'string' && job.label.startsWith('Reading Room ·');
}

function upsertJob(job) {
  if (isReaderJob(job)) return;
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

window.brain.onJobUpdate((job) => {
  upsertJob(job);
  readerJobUpdate(job);
});
window.brain.onJobOutput((payload) => {
  appendJobOutput(payload);
  readerJobOutput(payload);
});

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
    const div = el('button', 'sess');
    const head = el('div', 'sess-head');
    head.appendChild(el('span', 'sess-dot'));
    head.appendChild(el('span', 'sess-name', s.name));
    if (s.hasNotes) head.appendChild(el('span', 'sess-notes', 'Notes'));
    div.appendChild(head);
    div.appendChild(el('div', 'sess-meta', `pid ${s.pid} · ${s.tty} · ${s.etime}`));
    div.title = `${s.cwd}\nRead this session in the Reading Room`;
    div.addEventListener('click', () => showPage(`read:${s.pid}`));
    container.appendChild(div);
  }
  lastSessionList = list;
  if (currentPage.startsWith('read:')) refreshReaderSwitcher();
}
let lastSessionList = [];

async function loadSessions() {
  const container = document.getElementById('rail-sessions');
  await safely(container, 'sessions', async () => {
    renderSessions(await window.brain.listSessions());
  });
}

window.brain.onSessionsUpdate((list) => renderSessions(list));

// ======================= READING ROOM =======================
// Read one running Claude terminal as prose. The reader owns the center
// display while `body.read-mode` is on; the inspector (side thread) owns the
// right column. Transcript turns arrive from the backend (`readerOpen` +
// `onReaderTurns`) and are upserted by uuid, append-only; the DOM node that
// holds the current selection is never rebuilt underneath it. Auto-follow is
// off — this is reading, not monitoring.
const RR_PAGE = 40;
const rrDot = document.getElementById('rr-dot');
const rrNoteText = document.getElementById('rr-note-text');
const displayNote = document.getElementById('display-note');
const readerBar = document.getElementById('reader-bar');
const rrSwitch = document.getElementById('rr-switch');
const rrLatest = document.getElementById('rr-latest');
const rrAsk = document.getElementById('rr-ask');
rrLatest.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v8"/><path d="M2.5 6.5 6 10l3.5-3.5"/></svg><span>Latest</span>`;

const reader = {
  pid: null,
  sessionId: null,
  title: '',
  status: 'unknown',
  project: '',
  turns: [], // every turn known, oldest first
  nodes: new Map(), // uuid -> DOM node (rendered turns only)
  root: null, // .reader column
  earlier: null, // "Load earlier" pill
  visibleStart: 0, // index into turns of the first rendered turn
  deferred: new Map(), // uuid -> turn waiting because it holds the selection
  openToken: 0,
  api: null, // window.brain or the dev mock
};

const sel = {
  pillVisible: false,
  frozen: null, // { text, turnUuid, range }
  timer: null,
};

const thread = {
  id: null,
  pid: null,
  exchanges: [], // { q, a, mode, jobId, state: 'running'|'done'|'error', node, aNode, renderTimer }
  fullContext: false,
  forked: false,
  noted: false,
  saved: null, // topic title once saved
};

function readerApi() {
  if (window.brain && typeof window.brain.readerOpen === 'function') return window.brain;
  let mock = false;
  try {
    mock = localStorage.getItem('rr-mock') === '1';
  } catch {
    /* storage may be unavailable */
  }
  return mock ? rrMockApi() : null;
}

// ---------- enter / leave ----------
async function enterReadMode(pidStr) {
  const pid = Number(pidStr);
  const token = ++reader.openToken;
  const api = readerApi();
  reader.api = api;
  document.body.classList.add('read-mode');
  displayNote.hidden = false;
  readerBar.hidden = false;
  displayTitle.textContent = reader.pid === pid && reader.title ? reader.title : 'Reading Room';
  paintReaderStatus();
  clearSelectionState();
  if (reader.pid !== pid) {
    reader.turns = [];
    resetThread();
  }
  reader.nodes.clear();
  reader.deferred.clear();
  rrLatest.hidden = true;

  const root = el('div', 'reader');
  reader.root = root;
  displayBody.appendChild(root);

  if (!api) {
    root.appendChild(el('div', 'reader-soft', 'Reading Room backend not loaded'));
    displayTitle.textContent = 'Reading Room';
    rrNoteText.textContent = '';
    reader.pid = pid;
    refreshReaderSwitcher();
    renderInspector();
    return;
  }

  root.appendChild(el('div', 'reader-soft', 'Opening…'));
  let res;
  try {
    res = await api.readerOpen(pid);
  } catch (e) {
    res = { ok: false, error: errText(e) };
  }
  if (token !== reader.openToken) return; // another page/session won the race
  root.innerHTML = '';
  if (!res || !res.ok) {
    root.appendChild(el('div', 'reader-soft', `Couldn't open this session — ${(res && res.error) || 'no response'}`));
    reader.pid = pid;
    refreshReaderSwitcher();
    renderInspector();
    return;
  }
  reader.pid = pid;
  reader.sessionId = res.sessionId || null;
  reader.title = res.title || '';
  reader.status = res.status || 'unknown';
  reader.turns = Array.isArray(res.turns) ? res.turns.slice() : [];
  displayTitle.textContent = reader.title || 'Reading Room';
  paintReaderStatus();
  refreshReaderSwitcher();
  renderInspector();
  renderReaderTurns();
  displayBody.scrollTop = displayBody.scrollHeight; // open at the newest turn, synchronously
}

function leaveReadMode() {
  reader.openToken++;
  document.body.classList.remove('read-mode');
  displayNote.hidden = true;
  readerBar.hidden = true;
  rrLatest.hidden = true;
  clearSelectionState();
  reader.nodes.clear();
  reader.deferred.clear();
  reader.root = null;
  const api = reader.api;
  if (api && typeof api.readerClose === 'function') api.readerClose().catch(() => {});
}

function paintReaderStatus() {
  rrDot.classList.toggle('busy', reader.status === 'busy');
  const parts = [reader.status === 'busy' ? 'busy' : reader.status === 'idle' ? 'idle' : ''];
  if (reader.project) parts.push(reader.project);
  rrNoteText.textContent = parts.filter(Boolean).join(' · ');
  rrDot.title = reader.status;
}

// The 10 s sessions poll already carries sessionId/name/status per pid (from
// ~/.claude/sessions); asking the backend again would run ps + lsof a second
// time every tick while reading. Only the first paint (no list yet) asks.
function switcherListFromSessions(list) {
  return list.map((s) => ({
    pid: Number(s.pid),
    name: s.sessionName || `${s.name} · ${s.pid}`,
    project: s.name,
    cwd: s.cwd,
    status: s.activity || 'unknown',
    title: null,
  }));
}

async function refreshReaderSwitcher() {
  const api = reader.api;
  let list = lastSessionList.length ? switcherListFromSessions(lastSessionList) : [];
  if (!list.length) {
    try {
      if (api && typeof api.readerSessions === 'function') list = await api.readerSessions();
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];
  const me = list.find((s) => Number(s.pid) === reader.pid);
  if (me) {
    reader.project = me.project || '';
    if (me.status && me.status !== 'unknown') reader.status = me.status;
    if (!reader.title && (me.title || me.name)) displayTitle.textContent = me.title || me.name;
    paintReaderStatus();
  }
  rrSwitch.innerHTML = '';
  const shown = list.slice(0, 4);
  if (!shown.length) {
    readerBar.hidden = true;
    return;
  }
  readerBar.hidden = false;
  for (const s of shown) {
    const b = el('button', 'seg' + (Number(s.pid) === reader.pid ? ' active' : ''));
    const dot = el('span', 'rr-dot' + (s.status === 'busy' ? ' busy' : ''));
    b.appendChild(dot);
    b.appendChild(document.createTextNode(s.name || s.project || `pid ${s.pid}`));
    b.title = `${s.project || ''}${s.cwd ? '\n' + s.cwd : ''}`.trim();
    if (Number(s.pid) !== reader.pid) b.addEventListener('click', () => showPage(`read:${s.pid}`));
    rrSwitch.appendChild(b);
  }
}

async function openMostRecentReader() {
  const api = readerApi();
  let list = [];
  try {
    if (api && typeof api.readerSessions === 'function') list = await api.readerSessions();
  } catch {
    list = [];
  }
  if (!list.length) list = lastSessionList.map((s) => ({ pid: s.pid, status: 'unknown' }));
  if (!list.length) return status('No Claude terminals running.');
  const pick = list.find((s) => s.status === 'busy') || list[0];
  showPage(`read:${pick.pid}`);
}

// ---------- turn rendering ----------
function fmtTurnTime(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function buildTurn(turn) {
  const role = turn.role || 'assistant';
  const node = el('article', `turn turn-${role}` + (turn.queued ? ' queued' : ''));
  node.dataset.uuid = turn.uuid;
  const ts = fmtTurnTime(turn.ts);
  if (ts) node.appendChild(el('span', 'turn-ts', ts));

  if (role === 'user') {
    const bubble = el('div', 'bubble', String(turn.md || '').trim());
    node.appendChild(bubble);
    // Collapse long prompts to six lines; measured once mounted.
    requestAnimationFrame(() => {
      if (!bubble.isConnected) return;
      const lineH = parseFloat(getComputedStyle(bubble).lineHeight) || 19;
      if (bubble.scrollHeight > lineH * 7) {
        bubble.classList.add('clamped');
        const more = el('button', 'bubble-more', 'more');
        more.addEventListener('click', () => {
          const open = bubble.classList.toggle('clamped');
          more.textContent = open ? 'more' : 'less';
        });
        node.appendChild(more);
      }
    });
  } else if (role === 'tools') {
    const tools = Array.isArray(turn.tools) ? turn.tools : [];
    const names = [...new Set(tools.map((t) => t.name).filter(Boolean))];
    const row = el('button', 'tools-row');
    row.innerHTML = ICONS.back;
    const label = `Worked · ${tools.length} tool${tools.length === 1 ? '' : 's'}${names.length ? ' · ' + names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '') : ''}`;
    row.appendChild(document.createTextNode(label));
    row.addEventListener('click', () => node.classList.toggle('open'));
    node.appendChild(row);
    const list = el('div', 'tools-list');
    for (const t of tools) {
      const chip = el('div', 'tool-chip' + (t.isError ? ' err' : ''));
      chip.appendChild(el('span', 'tool-name', t.name || 'tool'));
      if (t.arg) chip.appendChild(el('span', 'tool-arg', t.arg));
      if (t.peek) chip.appendChild(el('span', 'tool-peek', t.peek));
      chip.title = [t.arg, t.peek].filter(Boolean).join('\n');
      list.appendChild(chip);
    }
    node.appendChild(list);
  } else {
    const md = el('div', 'turn-md');
    md.innerHTML = renderMarkdown(turn.md || '');
    for (const table of md.querySelectorAll('table')) {
      const wrap = el('div', 'tbl');
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
    node.appendChild(md);
  }
  return node;
}

function readerNearBottom() {
  return displayBody.scrollHeight - displayBody.scrollTop - displayBody.clientHeight < 48;
}

function renderReaderTurns() {
  const root = reader.root;
  if (!root) return;
  root.innerHTML = '';
  reader.nodes.clear();
  reader.visibleStart = Math.max(0, reader.turns.length - RR_PAGE);
  paintEarlierPill();
  if (!reader.turns.length) {
    root.appendChild(el('div', 'reader-soft', 'Nothing to read yet — this session has no turns.'));
    return;
  }
  for (let i = reader.visibleStart; i < reader.turns.length; i++) mountTurn(reader.turns[i], null);
}

function paintEarlierPill() {
  const root = reader.root;
  if (!root) return;
  if (reader.earlier && reader.earlier.parentNode !== root) reader.earlier = null;
  if (reader.visibleStart > 0) {
    if (!reader.earlier) {
      const b = el('button', 'rr-earlier');
      b.addEventListener('click', loadEarlierTurns);
      reader.earlier = b;
    }
    reader.earlier.textContent = `Load earlier · ${reader.visibleStart} more`;
    if (root.firstChild !== reader.earlier) root.prepend(reader.earlier);
  } else if (reader.earlier) {
    reader.earlier.remove();
    reader.earlier = null;
  }
}

function loadEarlierTurns() {
  const root = reader.root;
  if (!root || reader.visibleStart === 0) return;
  const prevHeight = displayBody.scrollHeight;
  const prevTop = displayBody.scrollTop;
  const from = Math.max(0, reader.visibleStart - RR_PAGE);
  let anchor = reader.earlier ? reader.earlier.nextSibling : root.firstChild;
  for (let i = from; i < reader.visibleStart; i++) {
    const node = buildTurn(reader.turns[i]);
    reader.nodes.set(reader.turns[i].uuid, node);
    root.insertBefore(node, anchor);
  }
  reader.visibleStart = from;
  paintEarlierPill();
  displayBody.scrollTop = prevTop + (displayBody.scrollHeight - prevHeight);
}

// Mount a turn at the end (before = null) or in place of an existing node.
function mountTurn(turn, replaceNode) {
  const node = buildTurn(turn);
  reader.nodes.set(turn.uuid, node);
  if (replaceNode) {
    if (replaceNode.classList.contains('open')) node.classList.add('open'); // keep the tools row expanded
    replaceNode.replaceWith(node);
  } else reader.root.appendChild(node);
  return node;
}

function selectionTurnUuid() {
  if (sel.frozen) return sel.frozen.turnUuid;
  // Not only while the pill shows: a drag in progress (before the 120 ms
  // debounce) is a selection too, and replacing its node would drop it.
  const s = window.getSelection();
  if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
  return turnUuidForNode(s.getRangeAt(0).startContainer);
}

function turnUuidForNode(node) {
  const elNode = node && node.nodeType === 1 ? node : node && node.parentElement;
  const turn = elNode && elNode.closest && elNode.closest('.turn[data-uuid]');
  return turn ? turn.dataset.uuid : null;
}

function upsertTurns(turns) {
  if (!reader.root || !Array.isArray(turns) || !turns.length) return;
  const wasNearBottom = readerNearBottom();
  const emptyNote = reader.root.querySelector('.reader-soft');
  if (emptyNote && reader.turns.length === 0) emptyNote.remove();
  const held = selectionTurnUuid();
  let appended = false;
  for (const turn of turns) {
    if (!turn || !turn.uuid) continue;
    const idx = reader.turns.findIndex((t) => t.uuid === turn.uuid);
    if (idx === -1) {
      reader.turns.push(turn);
      mountTurn(turn, null);
      appended = true;
      continue;
    }
    reader.turns[idx] = turn;
    if (idx < reader.visibleStart) continue; // not rendered yet
    const node = reader.nodes.get(turn.uuid);
    if (!node) continue;
    if (held && held === turn.uuid) {
      reader.deferred.set(turn.uuid, turn); // never rebuild under a live selection
      continue;
    }
    mountTurn(turn, node);
  }
  if (appended) {
    if (wasNearBottom) requestAnimationFrame(() => (displayBody.scrollTop = displayBody.scrollHeight));
    else rrLatest.hidden = false;
  }
}

function flushDeferredTurns() {
  if (!reader.deferred.size) return;
  const held = selectionTurnUuid();
  for (const [uuid, turn] of [...reader.deferred]) {
    if (uuid === held) continue;
    reader.deferred.delete(uuid);
    const node = reader.nodes.get(uuid);
    if (node) mountTurn(turn, node);
  }
}

rrLatest.addEventListener('click', () => {
  displayBody.scrollTop = displayBody.scrollHeight;
  rrLatest.hidden = true;
});
displayBody.addEventListener('scroll', () => {
  if (!currentPage.startsWith('read:')) return;
  if (!rrLatest.hidden && readerNearBottom()) rrLatest.hidden = true;
  if (sel.pillVisible) {
    const range = selectionInReader();
    if (range) placeAskPill(range);
    else hideAskPill();
  }
});

// ---------- live events ----------
function readerTurnsEvent(payload) {
  if (!payload || !currentPage.startsWith('read:')) return;
  if (Number(payload.pid) !== reader.pid) return;
  if (payload.sessionId && reader.sessionId && payload.sessionId !== reader.sessionId) return;
  upsertTurns(payload.turns);
}

function readerStatusEvent(payload) {
  if (!payload || Number(payload.pid) !== reader.pid) return;
  if (payload.status) reader.status = payload.status;
  if (payload.title) {
    reader.title = payload.title;
    if (currentPage.startsWith('read:')) displayTitle.textContent = payload.title;
  }
  paintReaderStatus();
  if (payload.swapped && reader.root) {
    reader.sessionId = payload.sessionId || null;
    reader.turns = [];
    reader.nodes.clear();
    reader.deferred.clear();
    reader.earlier = null;
    reader.visibleStart = 0;
    clearSelectionState();
    reader.root.innerHTML = '';
    reader.root.appendChild(el('div', 'rr-divider', 'Session cleared'));
  } else if (payload.sessionId) {
    reader.sessionId = payload.sessionId;
  }
  refreshReaderSwitcher();
}

if (window.brain && typeof window.brain.onReaderTurns === 'function') window.brain.onReaderTurns(readerTurnsEvent);
if (window.brain && typeof window.brain.onReaderStatus === 'function') window.brain.onReaderStatus(readerStatusEvent);

// ---------- selection → "Sor" pill ----------
function selectionInReader() {
  const s = window.getSelection();
  if (!s || s.rangeCount === 0 || s.isCollapsed || !reader.root) return null;
  const range = s.getRangeAt(0);
  const anchorEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  if (!anchorEl || !reader.root.contains(anchorEl)) return null;
  if (!String(s).trim()) return null;
  return range;
}

function placeAskPill(range) {
  const bodyRect = displayBody.getBoundingClientRect();
  // First line of the selection that is actually on screen — a selection
  // whose start scrolled above the fold must not park the pill on the header.
  const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
  let rect = rects.find((r) => r.bottom > bodyRect.top && r.top < bodyRect.bottom);
  if (!rect) rect = rects.length ? rects[0] : range.getBoundingClientRect();
  rrAsk.hidden = false;
  sel.pillVisible = true;
  const pw = rrAsk.offsetWidth;
  const ph = rrAsk.offsetHeight;
  let top = rect.top - ph - 8;
  if (top < bodyRect.top + 4) top = rect.bottom + 8;
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  rrAsk.style.top = `${Math.round(top)}px`;
  rrAsk.style.left = `${Math.round(left)}px`;
}

function hideAskPill() {
  rrAsk.hidden = true;
  sel.pillVisible = false;
  flushDeferredTurns();
}

function onSelectionChange() {
  clearTimeout(sel.timer);
  sel.timer = setTimeout(() => {
    if (!currentPage.startsWith('read:')) return hideAskPill();
    const range = selectionInReader();
    if (!range) return hideAskPill();
    placeAskPill(range);
  }, 120);
}
document.addEventListener('selectionchange', onSelectionChange);

function freezeSelection() {
  const range = selectionInReader();
  if (!range) return hideAskPill();
  const text = String(window.getSelection()).trim().slice(0, 4000);
  const turnUuid = turnUuidForNode(range.startContainer);
  clearHighlight();
  const frozenRange = range.cloneRange();
  if ('highlights' in CSS && typeof Highlight === 'function') {
    try {
      CSS.highlights.set('rr-selection', new Highlight(frozenRange));
      window.getSelection().removeAllRanges();
    } catch {
      /* keep the native selection as the fallback */
    }
  }
  sel.frozen = { text, turnUuid, range: frozenRange };
  hideAskPill();
  renderInspectorQuote();
  inspInput.focus();
}

rrAsk.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection alive
rrAsk.addEventListener('click', freezeSelection);

function clearHighlight() {
  if ('highlights' in CSS) {
    try {
      CSS.highlights.delete('rr-selection');
    } catch {
      /* nothing to clear */
    }
  }
}

function clearSelectionState() {
  hideAskPill();
  clearHighlight();
  sel.frozen = null;
  flushDeferredTurns();
  renderInspectorQuote();
}

function readerEscape() {
  if (sel.pillVisible) {
    hideAskPill();
    const s = window.getSelection();
    if (s) s.removeAllRanges();
    return;
  }
  if (sel.frozen) {
    clearHighlight();
    sel.frozen = null;
    flushDeferredTurns();
    renderInspectorQuote();
  }
}

// ---------- inspector (side thread) ----------
const inspQuote = document.getElementById('insp-quote');
const inspThread = document.getElementById('insp-thread');
const inspScroll = document.getElementById('insp-scroll');
const inspInput = document.getElementById('insp-input');
const inspSend = document.getElementById('insp-send');
const inspNote = document.getElementById('insp-note');
const inspSave = document.getElementById('insp-save');
const inspPicker = document.getElementById('insp-picker');
const inspCtx = document.getElementById('insp-ctx');
const inspHint = document.getElementById('insp-hint');

function resetThread() {
  for (const ex of thread.exchanges) clearTimeout(ex.renderTimer);
  thread.id = null;
  thread.pid = reader.pid;
  thread.exchanges = [];
  thread.forked = false;
  thread.noted = false;
  thread.saved = null;
  inspPicker.hidden = true;
  inspPicker.innerHTML = '';
}

function renderInspector() {
  renderInspectorQuote();
  inspThread.innerHTML = '';
  for (const ex of thread.exchanges) inspThread.appendChild(buildExchange(ex));
  paintInspectorPills();
  syncInspSend();
}

function renderInspectorQuote() {
  inspQuote.innerHTML = '';
  if (sel.frozen) {
    const q = el('div', 'insp-quote', sel.frozen.text);
    q.title = sel.frozen.text.length > 300 ? sel.frozen.text : '';
    inspQuote.appendChild(q);
  } else if (!thread.exchanges.length) {
    inspQuote.appendChild(el('div', 'insp-empty', 'Select a passage in the reader and press Sor — the answer lands here, beside what you were reading.'));
  }
}

function buildExchange(ex) {
  const node = el('div', 'ex');
  const q = el('div', 'ex-q');
  q.appendChild(el('div', 'bubble', ex.q));
  node.appendChild(q);
  const a = el('div', 'ex-a turn-md');
  node.appendChild(a);
  ex.node = node;
  ex.aNode = a;
  paintExchange(ex);
  return node;
}

function paintExchange(ex) {
  const a = ex.aNode;
  if (!a) return;
  if (ex.state === 'running' && !ex.a) {
    a.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    return;
  }
  a.innerHTML = renderMarkdown(ex.a || '');
  if (ex.state === 'error') a.appendChild(el('div', 'ex-err', ex.error || 'Rocky could not answer.'));
  let mode = ex.node.querySelector('.ex-mode');
  if (ex.state === 'done' && ex.mode === 'fork') {
    if (!mode) ex.node.appendChild(el('div', 'ex-mode', 'full context'));
  } else if (mode) mode.remove();
}

function scheduleExchangePaint(ex) {
  if (ex.renderTimer) return;
  ex.renderTimer = setTimeout(() => {
    ex.renderTimer = null;
    const follow = inspScroll.scrollHeight - inspScroll.scrollTop - inspScroll.clientHeight < 60;
    paintExchange(ex);
    if (follow) inspScroll.scrollTop = inspScroll.scrollHeight;
  }, 150);
}

function currentExchange() {
  return thread.exchanges.find((ex) => ex.state === 'running') || null;
}

function readerJobOutput(payload) {
  if (!payload) return;
  const ex = thread.exchanges.find((x) => x.jobId && x.jobId === payload.id && x.state === 'running');
  if (!ex) return;
  const text = payload.text != null ? payload.text : payload.chunk;
  if (!text) return;
  ex.a = (ex.a || '') + text;
  scheduleExchangePaint(ex);
}

function readerJobUpdate(job) {
  if (!job || !job.id) return;
  const ex = thread.exchanges.find((x) => x.jobId === job.id && x.state === 'running');
  if (!ex) return;
  const st = job.status || job.state;
  if (st === 'running' || !st) return;
  clearTimeout(ex.renderTimer);
  ex.renderTimer = null;
  if (typeof job.output === 'string' && job.output.length > (ex.a || '').length) ex.a = job.output;
  if (st === 'done') ex.state = 'done';
  else {
    ex.state = 'error';
    ex.error = st === 'killed' ? 'Stopped.' : `Rocky failed${job.exitCode != null ? ` (${job.exitCode})` : ''}.`;
  }
  paintExchange(ex);
  inspScroll.scrollTop = inspScroll.scrollHeight;
  paintInspectorPills();
  syncInspSend();
}

async function askFromInspector() {
  const api = reader.api;
  const question = inspInput.value.trim();
  if (currentExchange()) return;
  if (!api || typeof api.askRocky !== 'function') return inspError('Reading Room backend not loaded');
  if (!sel.frozen && !thread.id) return inspError('Select a passage first — then press Sor.');
  if (!reader.pid) return;
  const selection = sel.frozen ? sel.frozen.text : '';
  const turnUuid = sel.frozen ? sel.frozen.turnUuid : '';
  const q = question || 'Bunu anlamadım — açıklar mısın?';
  const ex = { q, a: '', mode: thread.fullContext ? 'fork' : 'mini', jobId: null, state: 'running' };
  if (!thread.exchanges.length) inspQuote.querySelector('.insp-empty')?.remove();
  thread.exchanges.push(ex);
  inspThread.appendChild(buildExchange(ex));
  inspScroll.scrollTop = inspScroll.scrollHeight;
  inspInput.value = '';
  autosizeInsp();
  syncInspSend();
  try {
    const res = await api.askRocky({
      pid: reader.pid,
      threadId: thread.id || undefined,
      selection,
      turnUuid,
      question: q,
      fullContext: thread.fullContext || undefined,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'no response');
    thread.id = res.threadId || thread.id;
    thread.pid = reader.pid;
    ex.jobId = res.jobId;
    ex.mode = res.mode || ex.mode;
    if (ex.mode === 'fork') thread.forked = true;
    paintCtxHint();
  } catch (e) {
    ex.state = 'error';
    ex.error = errText(e);
    paintExchange(ex);
    syncInspSend();
  }
}

function inspError(text) {
  const n = el('div', 'ex-err', text);
  inspThread.appendChild(n);
  inspScroll.scrollTop = inspScroll.scrollHeight;
  setTimeout(() => n.remove(), 4000);
}

function syncInspSend() {
  const busy = !!currentExchange();
  inspSend.disabled = busy;
  inspSend.classList.toggle('armed', !busy && (!!inspInput.value.trim() || !!sel.frozen));
}

function autosizeInsp() {
  inspInput.style.height = 'auto';
  inspInput.style.height = `${Math.min(inspInput.scrollHeight, 120)}px`;
}

inspInput.addEventListener('input', () => {
  autosizeInsp();
  syncInspSend();
});
inspInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  askFromInspector();
});
inspSend.addEventListener('click', askFromInspector);

document.getElementById('insp-new').addEventListener('click', () => {
  resetThread();
  renderInspector();
  inspInput.focus();
});

inspCtx.addEventListener('click', () => {
  thread.fullContext = !thread.fullContext;
  inspCtx.classList.toggle('engaged', thread.fullContext);
  inspCtx.setAttribute('aria-checked', String(thread.fullContext));
  paintCtxHint();
});
function paintCtxHint() {
  inspHint.hidden = !(thread.fullContext && !thread.forked);
}

function answeredCount() {
  return thread.exchanges.filter((ex) => ex.state === 'done' && ex.a).length;
}

function paintInspectorPills() {
  const ready = answeredCount() > 0 && !!thread.id;
  // note-back
  inspNote.classList.remove('commanded', 'done', 'busy');
  if (thread.noted) {
    inspNote.disabled = true;
    inspNote.classList.add('done');
    inspNote.innerHTML = `${ICONS.check} <span>Notlandı — bir sonraki mesajında görecek</span>`;
  } else {
    inspNote.disabled = !ready;
    inspNote.textContent = 'Terminale not bırak';
    if (ready) inspNote.classList.add('commanded');
  }
  // save to topics
  inspSave.classList.remove('commanded', 'done', 'busy');
  if (thread.saved) {
    inspSave.disabled = true;
    inspSave.classList.add('done');
    inspSave.innerHTML = `${ICONS.check} <span>${escapeHtml(thread.saved)}</span>`;
  } else {
    inspSave.disabled = !ready;
    inspSave.textContent = "Topics'e kaydet";
  }
}

inspNote.addEventListener('click', async () => {
  const api = reader.api;
  if (thread.noted || !thread.id || !api || typeof api.threadNote !== 'function') return;
  inspNote.classList.add('busy');
  try {
    const res = await api.threadNote({ pid: reader.pid, threadId: thread.id });
    if (!res || !res.ok) throw new Error((res && res.error) || 'note failed');
    thread.noted = true;
  } catch (e) {
    inspError(`Could not leave the note — ${errText(e)}`);
  }
  paintInspectorPills();
});

inspSave.addEventListener('click', async () => {
  const api = reader.api;
  if (thread.saved || !thread.id || !api || typeof api.listTopics !== 'function') return;
  if (!inspPicker.hidden) {
    inspPicker.hidden = true;
    return;
  }
  inspPicker.innerHTML = '';
  inspPicker.hidden = false;
  let topics = [];
  try {
    topics = await api.listTopics();
  } catch (e) {
    inspPicker.appendChild(el('div', 'insp-picker-empty', `Couldn't list topics — ${errText(e)}`));
    return;
  }
  if (!Array.isArray(topics) || !topics.length) {
    inspPicker.appendChild(el('div', 'insp-picker-empty', 'No notes in Learning/Topics yet.'));
    return;
  }
  for (const t of topics.slice(0, 12)) {
    const row = el('button', 'insp-picker-row', t.title || t.file);
    row.title = t.file;
    row.addEventListener('click', () => saveThreadToTopic(t));
    inspPicker.appendChild(row);
  }
});

async function saveThreadToTopic(topic) {
  const api = reader.api;
  inspPicker.hidden = true;
  inspSave.classList.add('busy');
  try {
    const res = await api.threadSave({ pid: reader.pid, threadId: thread.id, topicFile: topic.file });
    if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
    thread.saved = topic.title || topic.file;
  } catch (e) {
    inspError(`Could not save — ${errText(e)}`);
  }
  paintInspectorPills();
}

// ---------- dev mock (only when the backend is absent AND rr-mock=1) ----------
function rrMockApi() {
  if (window.__rrMock) return window.__rrMock;
  const now = Date.now();
  const t = (i, role, md, extra) => ({ uuid: `mock-${i}`, role, ts: new Date(now - (60 - i) * 90_000).toISOString(), md, ...(extra || {}) });
  const long = `## S11 parametre matrisi ve karar modülü

Yonga'nın anten dizisinden gelen **S11** ölçümleri 64×64'lük bir matris olarak geliyor. Her hücre bir frekans/açı çiftinde yansıma katsayısını (dB) tutuyor. Karar modülü bu matrisi üç adımda işliyor:

1. Frekans ekseninde *normalize* et (her satırı kendi medyanına böl).
2. Bir \`3×3\` medyan filtresi ile spike'ları bastır.
3. Eşik altındaki hücreleri maskele ve taş bölgesini bağlı bileşen olarak çıkar.

\`\`\`python
def decide(s11: np.ndarray, thr: float = -12.0) -> Mask:
    norm = s11 / np.median(s11, axis=1, keepdims=True)
    filt = median_filter(norm, size=3)
    return label(filt < thr)
\`\`\`

| Aşama | Girdi | Çıktı | Maliyet |
|---|---|---|---|
| normalize | 64×64 float32 | 64×64 float32 | O(n²) |
| median | 64×64 | 64×64 | O(9n²) |
| label | bool mask | k bileşen | O(n²) |

> Kritik nokta: eşik \`thr\` sabit değil — taşın boyutuna göre adaptif olmalı, yoksa küçük taşlar gürültüde kayboluyor.

Bir sonraki adım [parametric 32-bit](https://example.com) formatını okuyup bu pipeline'a bağlamak. Sorun çıkarsa \`decision/README.md\` dosyasına bak.

### Neden medyan, neden ortalama değil?

Ortalama filtre spike'ı komşulara yayar; medyan onu düşürür. S11 verisinde spike'lar kablo temasından geliyor, yani gerçek sinyal değil — bu yüzden **medyan** doğru tercih.`;
  const turns = [];
  for (let i = 0; i < 40; i++) {
    turns.push(i % 2 ? t(i, 'assistant', `Filler assistant turn ${i}. Kısa bir cevap — pagination testi için var.\n\nİkinci paragraf.`) : t(i, 'user', `Filler user prompt ${i}`));
  }
  const b = turns.length;
  turns.push(t(b + 0, 'user', 'Yonga decision modülünü baştan anlat, S11 matrisinden karar çıkana kadar.'));
  turns.push(t(b + 1, 'assistant', long));
  turns.push(t(b + 2, 'tools', '', { tools: [
    { name: 'Read', arg: 'decision/pipeline.py', peek: '128 lines' },
    { name: 'Bash', arg: 'python -m pytest tests/test_decision.py -q', peek: '4 passed in 0.31s' },
    { name: 'Grep', arg: 'median_filter', peek: '3 matches' },
  ] }));
  turns.push(t(b + 3, 'user', 'thr adaptif olsun dedin ama nasıl? taş boyutunu bilmiyoruz ki daha karar vermeden. Bu tavuk yumurta problemi değil mi? Ayrıca 32-bit parametric formatı hâlâ elimde yok, Ali Hoca yarın gönderecek dedi. O gelene kadar sentetik veri ile mi çalışalım yoksa bekleyelim mi? Bir de şunu merak ediyorum: median filtre 3×3 yerine 5×5 olsa küçük taşları da siler miyiz?'));
  turns.push(t(b + 4, 'assistant', `Haklısın, bu bir tavuk-yumurta problemi gibi görünüyor ama değil: eşiği taşın boyutundan değil, **arka planın dağılımından** çıkarıyoruz.

Normalize edilmiş matriste taş olmayan hücreler 1 civarında toplanır; \`thr = median - 3·MAD\` gibi sağlam bir istatistik, taşın büyüklüğünden bağımsız çalışır. Yani önce arka planı öğren, sonra sapanı bul.

5×5 medyan: evet, 2–3 hücrelik taşları siler. 3×3'te kal.`));
  turns.push(t(b + 5, 'tools', '', { tools: [
    { name: 'Bash', arg: 'python scripts/synth.py --n 200', peek: 'Traceback: FileNotFoundError: data/synth/', isError: true },
  ] }));
  turns.push(t(b + 6, 'error', 'API Error: 529 overloaded_error — retrying in 4s'));
  turns.push(t(b + 7, 'user', 'tamam sentetik ile devam, klasörü oluştur'));
  turns.push(t(b + 8, 'assistant', `Oluşturdum. \`data/synth/\` altında 200 örnek var; her biri \`.npy\` + bir JSON etiketi. Etiketler taş merkezini ve yarıçapını tutuyor, böylece karar modülünün çıktısını IoU ile puanlayabiliriz.`));
  turns.push(t(b + 9, 'tools', '', { tools: [
    { name: 'Write', arg: 'scripts/synth.py', peek: 'wrote 61 lines' },
    { name: 'Bash', arg: 'python scripts/synth.py --n 200', peek: 'ok · 200 files' },
  ] }));
  turns.push(t(b + 10, 'user', 'IoU eşiğini 0.5 al, sonuçları tabloya dök', { queued: true }));
  turns.push(t(b + 11, 'assistant', `Sıradaki adım kuyrukta. Beklerken şunu not edeyim: IoU 0.5 küçük taşlar için sert bir ölçüt — 0.3'te de raporlayalım.`));

  let seq = 0;
  const listeners = { out: [], upd: [] };
  const mock = {
    readerSessions: async () => [
      { pid: 82410, sessionId: 's1', name: 'yonga-renal', cwd: '~/Documents/Projects/yonga-renal', project: 'Yonga Biyomedikal', status: 'busy', title: 'Yonga decision modülü' },
      { pid: 83116, sessionId: 's2', name: 'second-brain-b4', cwd: '~/Documents/Projects/second_brain', project: 'Second Brain', status: 'idle', title: 'RockyOS öğrenme arayüzü' },
      { pid: 90711, sessionId: 's3', name: 'poylin', cwd: '~/Documents/Projects/poylin', project: 'Poylin Medikal AI', status: 'idle', title: '' },
    ],
    readerOpen: async (pid) => ({ ok: true, pid, sessionId: 's1', title: 'Yonga decision modülü', status: 'busy', turns }),
    readerClose: async () => ({ ok: true }),
    onReaderTurns: () => {},
    onReaderStatus: () => {},
    askRocky: async ({ question }) => {
      const jobId = `mock-job-${++seq}`;
      const answer = `**Kısa cevap:** adaptif eşik, taşı değil arka planı ölçer.\n\nNormalize edilmiş matriste taş olmayan hücreler 1 civarında kümelenir. \`median - 3·MAD\` bu kümenin dışını işaretler; taş kaç hücre kaplarsa kaplasın kural aynı kalır.\n\nSoru: "${question.slice(0, 40)}" — bunu kendi cümlelerinle 2–3 cümlede anlatır mısın?`;
      let i = 0;
      const step = () => {
        if (i >= answer.length) {
          for (const cb of listeners.upd) cb({ id: jobId, status: 'done', state: 'done' });
          return;
        }
        const chunk = answer.slice(i, i + 12);
        i += 12;
        for (const cb of listeners.out) cb({ id: jobId, text: chunk });
        setTimeout(step, 40);
      };
      setTimeout(step, 400);
      return { ok: true, threadId: 'mock-thread', jobId, mode: thread.fullContext ? 'fork' : 'mini' };
    },
    threadNote: async () => ({ ok: true, file: '~/.claude/reading-room/notes/s1.md' }),
    threadSave: async () => ({ ok: true, file: 'Learning/Topics/Yonga.md' }),
    listTopics: async () => [
      { file: 'Learning/Topics/Yonga-Renal.md', title: 'Yonga Renal' },
      { file: 'Learning/Topics/Guitar.md', title: 'Guitar' },
      { file: 'Learning/Topics/Reinforcement-Learning.md', title: 'Reinforcement Learning' },
    ],
    _push: (turnsToPush) => readerTurnsEvent({ pid: reader.pid, sessionId: 's1', turns: turnsToPush }),
  };
  listeners.out.push(readerJobOutput);
  listeners.upd.push(readerJobUpdate);
  window.__rrMock = mock;
  return mock;
}

// ======================= init =======================
document.body.classList.toggle('mac', navigator.platform.startsWith('Mac'));
document.getElementById('refresh').innerHTML = ICONS.refresh;
document.getElementById('tasks-head').addEventListener('click', () => showPage(currentPage === 'day' ? 'now' : 'day'));
document.getElementById('fma-term-cell').addEventListener('click', openMostRecentReader);

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
