// Rocky OS — Mission Control renderer.
//
// Two halves: the state panels on the left are pull-only reads of the vault
// (loaded on open, on focus, and on ⟳ — never on a timer), and the agent
// monitor on the right is push-only (main sends job events as they happen, and
// the session list on the shared 10s poll that only runs while this window or
// the Dashboard is open).

// ======================= markdown-lite (same as dashboard.js) =======================
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

// Every panel is wrapped in this: a panel whose source file is missing or has
// changed shape should go quiet, log, and leave the rest of the window alone.
async function safely(container, label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`[mission-control] ${label} panel failed`, e);
    if (container) setError(container, e);
  }
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

// ======================= top bar =======================
const cmdInput = document.getElementById('cmd');
const cmdStatus = document.getElementById('cmd-status');

function renderTodayLine() {
  document.getElementById('today-line').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function prefill(text) {
  cmdInput.value = text;
  cmdInput.focus();
  cmdInput.setSelectionRange(text.length, text.length);
}

async function loadChips() {
  const chips = document.getElementById('chips');
  await safely(null, 'reviews-due', async () => {
    const due = await window.brain.reviewsDue();
    chips.innerHTML = '';
    if (due.weekly && due.weekly.due) {
      const b = el('button', 'chip', `Weekly review due · ${due.weekly.id}`);
      b.addEventListener('click', () => prefill('/weekly-review'));
      chips.appendChild(b);
    }
    if (due.monthly && due.monthly.due) {
      const b = el('button', 'chip', `Monthly review due · ${due.monthly.id}`);
      b.addEventListener('click', () => prefill('/monthly-review'));
      chips.appendChild(b);
    }
  });
}

// ======================= command bar + quick actions =======================
// These are exactly the slash commands I'd type into a terminal in the vault —
// dispatching them from here just saves finding a terminal first.
const QUICK_ACTIONS = [
  { label: 'Start Day', command: '/start-day' },
  { label: 'End of Day', command: '/end-of-day' },
  { label: 'Process Inbox', command: '/process-inbox' },
  { label: 'Save Session', command: '/save' },
  { label: 'Weekly Review', command: '/weekly-review' },
];

function renderQuickActions() {
  const wrap = document.getElementById('quick');
  for (const action of QUICK_ACTIONS) {
    const b = el('button', 'quick-btn', action.label);
    b.title = `Dispatch ${action.command} to Rocky in the vault`;
    // No confirmation dialog: I clicked it, that is the confirmation.
    b.addEventListener('click', () => dispatch(action.command, action.label));
    wrap.appendChild(b);
  }
}

// ipcRenderer.invoke wraps a main-process throw as
// "Error invoking remote method 'rocky:dispatch': Error: <the real message>".
// The real message is the only part worth showing on the status line.
function errText(e) {
  const raw = (e && e.message) || String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

function status(text, isError) {
  cmdStatus.textContent = text || '';
  cmdStatus.classList.toggle('err', !!isError);
}

async function dispatch(prompt, label) {
  const text = String(prompt || '').trim();
  if (!text) return;
  status('Dispatching…');
  try {
    const job = await window.brain.dispatchJob(text, label || null);
    upsertJob(job, { autoOpen: true });
    status(`Dispatched ${label || 'job'}`);
    if (!label) cmdInput.value = '';
  } catch (e) {
    // Refusals (same job already running, too many at once) land here too —
    // they're a visible notice on the status line, never a silent drop.
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
  } catch (e) {
    status(errText(e), true);
  }
}

cmdInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  // ⌘↵ (or Ctrl↵) hands the same prompt to an interactive session in Terminal
  // instead — for the big jobs I want to watch and steer rather than read after.
  if (e.metaKey || e.ctrlKey) dispatchToTerminal(cmdInput.value);
  else dispatch(cmdInput.value);
});
document.getElementById('cmd-send').addEventListener('click', () => dispatch(cmdInput.value));

// ======================= Today: tasks + agenda =======================
let toggleBusy = false;

async function toggleTask(item, box) {
  if (toggleBusy) return;
  toggleBusy = true;
  box.classList.add('busy');
  try {
    await window.brain.toggleTask({ file: item.file, line: item.line, raw: item.raw });
    await loadToday(); // rebuilds the list, so this row (and its class) is gone
  } catch (e) {
    // The row survives a failed toggle — un-dim it, or it looks stuck forever.
    box.classList.remove('busy');
    status(`Could not update that task — ${errText(e)}`, true);
  } finally {
    toggleBusy = false;
  }
}

function renderTaskItem(item) {
  const row = el('div', 'item' + (item.checked ? ' checked' : ''));
  const box = el('div', 'item-check', item.checked ? '✓' : '');
  const txt = el('div', 'item-text');
  txt.innerHTML = renderInline(item.text);
  row.appendChild(box);
  row.appendChild(txt);
  row.addEventListener('click', () => {
    // The whole row is the click target (fat, forgiving), which means a
    // text-selection drag across a task ends in a mouseup on it. Selecting a
    // task's text is reading, not checking it off — so don't write to the vault.
    const selection = window.getSelection();
    if (selection && String(selection).trim()) return;
    toggleTask(item, box);
  });
  return row;
}

async function loadToday() {
  const list = document.getElementById('list-today');
  await safely(list, 'today', async () => {
    const items = await window.brain.todayTasks();
    const open = items.filter((i) => !i.checked).length;
    document.getElementById('count-today').textContent = open;
    document.getElementById('today-note').textContent = items.length
      ? `${items.length - open} done of ${items.length}`
      : '';

    if (!items.length) {
      setEmpty(list, "No tasks in today's note yet — Start Day builds it.");
      return;
    }
    list.innerHTML = '';
    // Daily notes bucket tasks under `### ` sub-headings; keep those groups so
    // "Bugünün işi" doesn't blur into the parked backlog underneath it.
    let group = null;
    for (const item of items) {
      if (item.group !== group) {
        group = item.group;
        if (group) list.appendChild(el('div', 'group-label', group));
      }
      list.appendChild(renderTaskItem(item));
    }
  });
}

async function loadAgenda() {
  const list = document.getElementById('list-agenda');
  setEmpty(list, 'Checking calendar…');
  await safely(list, 'agenda', async () => {
    const agenda = await window.brain.agenda();
    if (!agenda.connected) {
      setEmpty(list, 'Calendar not connected.');
      return;
    }
    if (!agenda.days.length) {
      setEmpty(list, 'Nothing scheduled in the next few days.');
      return;
    }
    list.innerHTML = '';
    for (const day of agenda.days) {
      list.appendChild(el('div', 'ev-day', day.label));
      for (const ev of day.events) {
        const row = el('div', 'ev');
        row.appendChild(el('span', 'ev-time', ev.time || 'all day'));
        const t = el('span', 'ev-title');
        t.innerHTML = renderInline(ev.title);
        row.appendChild(t);
        list.appendChild(row);
      }
    }
  });
}

// ======================= Life Threads =======================
function renderThread(thread) {
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
  div.addEventListener('click', () => div.classList.toggle('expanded'));
  return div;
}

async function loadThreads() {
  const list = document.getElementById('list-threads');
  await safely(list, 'life-threads', async () => {
    const threads = await window.brain.lifeThreads();
    const active = threads.filter((t) => /active/i.test(t.section));
    const rest = threads.length - active.length;
    document.getElementById('count-threads').textContent = active.length;
    document.getElementById('threads-note').textContent = rest ? `+${rest} simmering / dormant` : '';

    if (!active.length) {
      setEmpty(list, threads.length ? 'No active threads.' : 'Life-Threads.md not found.');
      return;
    }
    list.innerHTML = '';
    for (const t of active) list.appendChild(renderThread(t));
  });
}

// ======================= Projects =======================
async function loadProjects() {
  const list = document.getElementById('list-projects');
  await safely(list, 'projects', async () => {
    const projects = await window.brain.projectsBrief();
    document.getElementById('count-projects').textContent = projects.length;
    if (!projects.length) {
      setEmpty(list, 'No project registry found.');
      return;
    }
    list.innerHTML = '';
    for (const p of projects) {
      const div = el('div', 'proj');
      const name = el('div', 'proj-name');
      const label = el('span');
      label.innerHTML = renderInline(p.name);
      name.appendChild(label);
      // The registry's graph column is prose — "✅ built", "❌ not built on
      // this machine", "—". Only the ✅ rows actually have a graph to query.
      if (/✅/.test(p.graph || '')) name.appendChild(el('span', 'proj-graph', 'graph'));
      div.appendChild(name);
      const st = el('div', 'proj-status');
      st.innerHTML = renderInline(p.status);
      div.appendChild(st);
      div.title = p.path || '';
      list.appendChild(div);
    }
  });
}

// ======================= Inbox =======================
async function loadInbox() {
  const list = document.getElementById('list-inbox');
  await safely(list, 'inbox', async () => {
    const inbox = await window.brain.inbox();
    document.getElementById('count-inbox').textContent = inbox.total;
    if (!inbox.total) {
      setEmpty(list, 'Inbox clear.');
      return;
    }
    list.innerHTML = '';
    for (const item of inbox.items) {
      const div = el('div', 'inbox-item');
      div.appendChild(el('div', 'inbox-name', item.name));
      if (item.source) div.appendChild(el('div', 'inbox-src', item.source));
      list.appendChild(div);
    }
    if (inbox.mobile) {
      const b = el('button', 'quick-btn', `Route ${inbox.mobile} phone capture${inbox.mobile === 1 ? '' : 's'}`);
      b.style.marginTop = '8px';
      b.addEventListener('click', () => dispatch('/process-inbox', 'Process Inbox'));
      list.appendChild(b);
    }
  });
}

// ======================= Health =======================
async function loadHealth() {
  const list = document.getElementById('list-health');
  await safely(list, 'health', async () => {
    const health = await window.brain.health();
    document.getElementById('health-note').textContent = health.loggedToday
      ? 'logged today'
      : 'not logged today';

    if (!health.rows.length) {
      setEmpty(list, 'No trend log rows.');
      return;
    }
    list.innerHTML = '';
    for (const row of health.rows) {
      const div = el('div', 'health-row');
      div.appendChild(el('span', 'health-date', row.date));
      // Columns are "🚬 Cigs", "⚡ Energy drinks", … — the leading glyph is
      // enough of a label at this width, so keep that and drop the word.
      const parts = [];
      for (let i = 1; i < health.columns.length - 1; i++) {
        const value = (row.cells[i] || '').trim();
        if (!value || value === '—' || value === '-') continue;
        const icon = (health.columns[i] || '').split(' ')[0];
        parts.push(`${icon} ${value}`);
      }
      div.appendChild(el('span', 'health-vals', parts.join(' · ') || '—'));
      div.title = row.cells[row.cells.length - 1] || '';
      list.appendChild(div);
    }
  });
}

// ======================= Agent monitor: Rocky jobs =======================
const jobEls = new Map(); // id -> { root, log, meta, kill }
const jobState = new Map(); // id -> last job snapshot
let tickTimer = null;
// Main caps each job's buffer at 60KB; the log element has to cap itself too,
// or a long job grows an unbounded pile of text nodes in here regardless.
const MAX_LOG_CHARS = 60_000;

function jobTitle(job) {
  if (job.label) return job.label;
  return String(job.prompt || '').split('\n')[0].slice(0, 90);
}

function jobMetaText(job) {
  const end = job.state === 'running' ? Date.now() : job.endedAt || job.startedAt;
  const elapsed = fmtDuration(end - job.startedAt);
  // "stopping" = SIGTERM sent, process hasn't exited yet. The card says so
  // instead of claiming it's dead before it is.
  if (job.stopping) return `stopping… · ${elapsed}`;
  if (job.state === 'running') return `running · ${elapsed}`;
  if (job.state === 'killed') return `stopped · ${elapsed}`;
  if (job.state === 'failed') return `failed${job.exitCode == null ? '' : ` (${job.exitCode})`} · ${elapsed}`;
  return `done · ${elapsed}`;
}

function buildJobCard(job) {
  const root = el('div', 'job');
  root.dataset.id = job.id;

  const head = el('div', 'job-head');
  head.appendChild(el('span', 'job-dot'));
  head.appendChild(el('span', 'job-title', jobTitle(job)));
  const meta = el('span', 'job-meta');
  head.appendChild(meta);
  const kill = el('button', 'job-kill', 'Stop');
  kill.addEventListener('click', (e) => {
    e.stopPropagation();
    window.brain.killJob(job.id).catch(() => {});
  });
  head.appendChild(kill);
  const caret = el('span', 'job-caret', '▸');
  head.appendChild(caret);

  const log = el('pre', 'job-log');
  head.addEventListener('click', () => {
    root.classList.toggle('open');
    caret.textContent = root.classList.contains('open') ? '▾' : '▸';
  });

  root.appendChild(head);
  root.appendChild(log);
  return { root, log, meta, kill, caret, logLen: 0 };
}

function paintJob(job) {
  const parts = jobEls.get(job.id);
  if (!parts) return;
  parts.root.classList.remove('running', 'done', 'failed', 'killed');
  parts.root.classList.add(job.state);
  parts.meta.textContent = jobMetaText(job);
  parts.kill.style.display = job.state === 'running' ? '' : 'none';
  parts.kill.textContent = job.stopping ? 'Force' : 'Stop';
}

function upsertJob(job, { autoOpen } = {}) {
  jobState.set(job.id, { ...(jobState.get(job.id) || {}), ...job });
  const merged = jobState.get(job.id);
  const container = document.getElementById('list-jobs');

  let parts = jobEls.get(job.id);
  if (!parts) {
    parts = buildJobCard(merged);
    jobEls.set(job.id, parts);
    const placeholder = container.querySelector('.empty');
    if (placeholder) placeholder.remove();
    container.prepend(parts.root);
    if (merged.output) {
      parts.log.textContent = merged.output;
      parts.logLen = merged.output.length;
    }
    if (autoOpen || merged.state === 'running') {
      parts.root.classList.add('open');
      parts.caret.textContent = '▾';
    }
  }
  paintJob(merged);
  updateAgentCount();
  syncTicker();
}

function appendJobOutput({ id, chunk }) {
  const parts = jobEls.get(id);
  const snap = jobState.get(id);
  if (snap) {
    snap.output = (snap.output || '') + chunk;
    if (snap.output.length > MAX_LOG_CHARS * 2) snap.output = snap.output.slice(-MAX_LOG_CHARS);
  }
  if (!parts) return;
  const nearBottom = parts.log.scrollHeight - parts.log.scrollTop - parts.log.clientHeight < 40;
  parts.log.appendChild(document.createTextNode(chunk));
  // Collapse the accumulated text nodes back into one capped string once the
  // log has grown past twice the cap — amortised, so it isn't a rebuild per
  // chunk, and it keeps the tail (which is the part I'm watching). The length
  // is tracked rather than read back, since reading textContent walks every
  // node in the log.
  parts.logLen += chunk.length;
  if (parts.logLen > MAX_LOG_CHARS * 2) {
    const kept = parts.log.textContent.slice(-MAX_LOG_CHARS);
    parts.log.textContent = kept;
    parts.logLen = kept.length;
  }
  if (nearBottom) parts.log.scrollTop = parts.log.scrollHeight;
}

// A 1s tick, but only while something is actually running — the moment the last
// job finishes the interval is cleared, so an idle window ticks nothing.
function syncTicker() {
  const anyRunning = [...jobState.values()].some((j) => j.state === 'running');
  if (anyRunning && !tickTimer) {
    tickTimer = setInterval(() => {
      for (const job of jobState.values()) if (job.state === 'running') paintJob(job);
    }, 1000);
  } else if (!anyRunning && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function loadJobs() {
  const container = document.getElementById('list-jobs');
  await safely(container, 'jobs', async () => {
    // Wipe *before* the await, not after: a job event that lands while the IPC
    // round-trip is in flight used to be built into an element and then have
    // its map entry thrown away, so every later chunk for that job silently
    // went nowhere. Clearing first means such an event just re-creates its card.
    container.innerHTML = '';
    jobEls.clear();
    jobState.clear();
    const jobs = await window.brain.listJobs();
    if (!jobs.length && !jobEls.size) {
      setEmpty(container, 'No jobs yet — dispatch one above.');
      syncTicker();
      return;
    }
    // listJobs() is newest-first and upsert prepends, so walk it backwards.
    for (const job of [...jobs].reverse()) upsertJob(job);
  });
}

window.brain.onJobUpdate((job) => upsertJob(job));
window.brain.onJobOutput((payload) => appendJobOutput(payload));

// ======================= Agent monitor: terminal sessions =======================
let sessionCount = 0;

function updateAgentCount() {
  const running = [...jobState.values()].filter((j) => j.state === 'running').length;
  document.getElementById('count-agents').textContent = `${running} running · ${sessionCount} terminals`;
}

function renderSessions(list) {
  sessionCount = list.length;
  const container = document.getElementById('list-sessions');
  container.innerHTML = '';
  if (!list.length) {
    setEmpty(container, 'No Claude terminals running.');
    updateAgentCount();
    return;
  }
  for (const s of list) {
    const div = el('div', 'sess');
    const head = el('div', 'sess-head');
    head.appendChild(el('span', 'sess-dot'));
    head.appendChild(el('span', 'sess-name', s.name));
    if (s.hasNotes) head.appendChild(el('span', 'sess-notes', 'notes'));
    div.appendChild(head);
    div.appendChild(el('div', 'sess-meta', `pid ${s.pid} · ${s.tty} · open ${s.etime}`));
    div.appendChild(el('div', 'sess-path', s.cwd));
    container.appendChild(div);
  }
  updateAgentCount();
}

async function loadSessions() {
  const container = document.getElementById('list-sessions');
  await safely(container, 'sessions', async () => {
    renderSessions(await window.brain.listSessions());
  });
}

window.brain.onSessionsUpdate((list) => renderSessions(list));

// ======================= init =======================
function refreshAll() {
  renderTodayLine();
  loadChips();
  loadToday();
  loadAgenda();
  loadThreads();
  loadProjects();
  loadInbox();
  loadHealth();
  loadSessions();
}

document.getElementById('refresh').addEventListener('click', refreshAll);

// Re-read the vault when I come back to the window — I might have been editing
// notes in Obsidian in between. Still no timer: focus is an event.
window.addEventListener('focus', () => {
  loadToday();
  loadInbox();
  loadChips();
});

renderQuickActions();
refreshAll();
loadJobs();
