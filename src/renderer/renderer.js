// ======================= view switching =======================
const tabNotes = document.getElementById('tab-notes');
const tabTimer = document.getElementById('tab-timer');
const tabArticle = document.getElementById('tab-article');
const viewNotes = document.getElementById('view-notes');
const viewTimer = document.getElementById('view-timer');
const viewArticle = document.getElementById('view-article');

function showView(which) {
  tabNotes.classList.toggle('active', which === 'notes');
  tabTimer.classList.toggle('active', which === 'timer');
  tabArticle.classList.toggle('active', which === 'article');
  viewNotes.classList.toggle('hidden', which !== 'notes');
  viewTimer.classList.toggle('hidden', which !== 'timer');
  viewArticle.classList.toggle('hidden', which !== 'article');
  if (which === 'notes') input.focus();
  if (which === 'article') aTitle.focus();
}
tabNotes.addEventListener('click', () => showView('notes'));
tabTimer.addEventListener('click', () => showView('timer'));
tabArticle.addEventListener('click', () => showView('article'));

// ======================= cig counter =======================
const cigBtn = document.getElementById('cig-counter');
const cigCountEl = document.getElementById('cig-count');

async function refreshCigCount() {
  try {
    cigCountEl.textContent = await window.brain.cigCount();
  } catch {
    /* non-fatal */
  }
}

async function logCig(delta) {
  cigBtn.disabled = true;
  try {
    cigCountEl.textContent = await window.brain.logCig(delta);
  } finally {
    cigBtn.disabled = false;
  }
}

cigBtn.addEventListener('click', () => logCig(1));
cigBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  logCig(-1);
});

refreshCigCount();

// ======================= window buttons =======================
const pinBtn = document.getElementById('pin-claude');
pinBtn.addEventListener('click', async () => {
  pinBtn.disabled = true;
  try {
    const result = await window.brain.pinClaude(); // 'PINNED' | 'UNPINNED' | 'NOTFOUND'
    pinBtn.classList.toggle('active', result === 'PINNED');
    pinBtn.title =
      result === 'NOTFOUND'
        ? 'No Claude window found — open it first'
        : result === 'PINNED'
          ? 'Claude pinned on top (click to unpin)'
          : 'Pin Claude window on top';
  } finally {
    pinBtn.disabled = false;
  }
});

document.getElementById('dashboard').addEventListener('click', () => window.brain.openDashboard());
document.getElementById('hide').addEventListener('click', () => window.brain.hide());
document.getElementById('quit').addEventListener('click', () => window.brain.quit());
document.querySelectorAll('.dock-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    window.brain.dock(btn.dataset.edge);
    document.querySelectorAll('.dock-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ======================= NOTES =======================
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const status = document.getElementById('status');
const list = document.getElementById('list');

function renderNotes(notes) {
  list.innerHTML = '';
  if (!notes || notes.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No notes captured yet today.';
    list.appendChild(li);
    return;
  }
  for (const raw of notes) {
    const li = document.createElement('li');
    const m = raw.match(/^(\d{2}:\d{2})\s+—\s+([\s\S]*)$/);
    if (m) {
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = m[1];
      li.appendChild(t);
      li.appendChild(document.createTextNode(m[2]));
    } else {
      li.textContent = raw;
    }
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

async function refreshNotes() {
  try {
    renderNotes(await window.brain.todayNotes());
  } catch {
    /* non-fatal */
  }
}

let clearStatus;
function flash(msg, ok = true) {
  status.textContent = msg;
  status.style.color = ok ? 'var(--muted)' : 'var(--danger)';
  clearTimeout(clearStatus);
  clearStatus = setTimeout(() => (status.textContent = ''), 2500);
}

async function sendNote() {
  const text = input.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  try {
    await window.brain.appendNote(text);
    input.value = '';
    flash('Saved to today’s note ✓');
    await refreshNotes();
  } catch (e) {
    flash('Failed to save: ' + (e && e.message ? e.message : e), false);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.addEventListener('click', sendNote);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendNote();
  }
  if (e.key === 'Escape') window.brain.hide();
});

// ======================= TIMER =======================
const clockEl = document.getElementById('clock');
const clockLabel = document.getElementById('clock-label');
const dotsEl = document.getElementById('dots');
const taskEl = document.getElementById('task');
const mainBtn = document.getElementById('main-action');
const stopBtn = document.getElementById('stop');
const timerStatus = document.getElementById('timer-status');
const mFocus = document.getElementById('m-focus');
const mPomo = document.getElementById('m-pomo');

const WORK = 25 * 60;
const BREAK = 5 * 60;

let mode = 'focus'; // 'focus' | 'pomodoro'
let running = false;
let paused = false;
let onBreak = false;
let elapsed = 0; // focus: seconds counted up
let remaining = WORK; // pomodoro: seconds counting down
let segWorked = 0; // worked seconds in the current segment (pause-aware)
let pomCount = 0;
let ticker = null;

function fmt(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function renderDots() {
  dotsEl.innerHTML = '';
  const n = Math.min(pomCount, 8);
  for (let i = 0; i < 8 && i < Math.max(n, 0); i++) {
    const d = document.createElement('span');
    d.className = 'dot done';
    dotsEl.appendChild(d);
  }
}

function draw() {
  if (mode === 'focus') {
    clockEl.textContent = fmt(elapsed);
    clockLabel.textContent = 'Focus';
  } else if (onBreak) {
    clockEl.textContent = fmt(remaining);
    clockLabel.textContent = 'Break';
  } else {
    clockEl.textContent = fmt(remaining);
    clockLabel.textContent = `Pomodoro ${pomCount + 1}`;
  }
}

function notify(msg) {
  timerStatus.textContent = msg;
  try {
    new Notification('Second Brain Timer', { body: msg });
  } catch {
    /* notifications optional */
  }
}

function setMode(m) {
  if (running || paused) return; // don't switch mid-session
  mode = m;
  mFocus.classList.toggle('active', m === 'focus');
  mPomo.classList.toggle('active', m === 'pomodoro');
  document.body.classList.toggle('pomo', m === 'pomodoro');
  document.body.classList.remove('brk');
  elapsed = 0;
  remaining = WORK;
  onBreak = false;
  pomCount = 0;
  segWorked = 0;
  renderDots();
  draw();
}
mFocus.addEventListener('click', () => setMode('focus'));
mPomo.addEventListener('click', () => setMode('pomodoro'));

async function logSession(duration, poms, completed) {
  const mins = Math.round(duration);
  if (mins < 1) return;
  try {
    await window.brain.logPomodoro({
      label: taskEl.value.trim() || 'Untitled session',
      duration: mins,
      pomodoros: poms,
      mode,
      completed,
    });
  } catch {
    /* non-fatal */
  }
}

function tick() {
  if (mode === 'focus') {
    elapsed++;
    segWorked++;
  } else if (onBreak) {
    remaining--;
    if (remaining <= 0) {
      // break over → next work segment
      onBreak = false;
      document.body.classList.remove('brk');
      remaining = WORK;
      segWorked = 0;
      notify(`Break done — pomodoro ${pomCount + 1} starting`);
    }
  } else {
    remaining--;
    segWorked++;
    if (remaining <= 0) {
      // completed a full pomodoro
      pomCount++;
      renderDots();
      logSession(25, pomCount, true);
      onBreak = true;
      document.body.classList.add('brk');
      remaining = BREAK;
      notify(`🍅 Pomodoro ${pomCount} done — 5 min break`);
    }
  }
  draw();
}

function start() {
  if (!taskEl.value.trim()) {
    taskEl.focus();
    taskEl.placeholder = 'Enter a task first ↑';
    return;
  }
  running = true;
  paused = false;
  onBreak = false;
  elapsed = 0;
  remaining = WORK;
  segWorked = 0;
  pomCount = 0;
  renderDots();
  taskEl.disabled = true;
  mainBtn.textContent = 'Pause';
  stopBtn.classList.remove('hidden');
  timerStatus.textContent = '';
  if (Notification && Notification.requestPermission) {
    try { Notification.requestPermission(); } catch {}
  }
  ticker = setInterval(tick, 1000);
  draw();
}

function pause() {
  clearInterval(ticker);
  ticker = null;
  running = false;
  paused = true;
  mainBtn.textContent = 'Resume';
}

function resume() {
  running = true;
  paused = false;
  mainBtn.textContent = 'Pause';
  ticker = setInterval(tick, 1000);
}

async function stop() {
  clearInterval(ticker);
  ticker = null;
  // log the partial worked segment (breaks are not logged; completed poms
  // were already logged as they finished)
  if (!onBreak && segWorked >= 60) {
    if (mode === 'focus') {
      await logSession(Math.round(elapsed / 60), 0, false);
    } else {
      await logSession(Math.round(segWorked / 60), pomCount, false);
    }
  }
  resetTimer();
}

function resetTimer() {
  running = false;
  paused = false;
  onBreak = false;
  elapsed = 0;
  remaining = WORK;
  segWorked = 0;
  pomCount = 0;
  document.body.classList.remove('brk');
  taskEl.disabled = false;
  mainBtn.textContent = 'Start';
  stopBtn.classList.add('hidden');
  renderDots();
  draw();
}

mainBtn.addEventListener('click', () => {
  if (!running && !paused) start();
  else if (running) pause();
  else resume();
});
stopBtn.addEventListener('click', stop);

// ======================= ARTICLE =======================
const aTitle = document.getElementById('a-title');
const aUrl = document.getElementById('a-url');
const aSource = document.getElementById('a-source');
const aHighlights = document.getElementById('a-highlights');
const aThoughts = document.getElementById('a-thoughts');
const aTakeaway = document.getElementById('a-takeaway');
const aStatus = document.getElementById('a-status');
const aSaveBtn = document.getElementById('a-save');
const aClearBtn = document.getElementById('a-clear');
const articleFieldEls = [aTitle, aUrl, aSource, aHighlights, aThoughts, aTakeaway];

function articleFields() {
  return {
    title: aTitle.value,
    url: aUrl.value,
    source: aSource.value,
    highlights: aHighlights.value,
    thoughts: aThoughts.value,
    takeaway: aTakeaway.value,
  };
}

function fillArticle(draft) {
  aTitle.value = draft?.title || '';
  aUrl.value = draft?.url || '';
  aSource.value = draft?.source || '';
  aHighlights.value = draft?.highlights || '';
  aThoughts.value = draft?.thoughts || '';
  aTakeaway.value = draft?.takeaway || '';
}

// Debounced autosave so switching tabs (or the app closing) mid-read doesn't
// lose typed notes — mirrors the pattern the window-position saver uses.
let aDraftTimer;
function scheduleDraftSave() {
  clearTimeout(aDraftTimer);
  aDraftTimer = setTimeout(async () => {
    const f = articleFields();
    if (!f.title && !f.url && !f.highlights && !f.thoughts && !f.takeaway) return;
    try {
      await window.brain.saveArticleDraft(f);
    } catch {
      /* non-fatal */
    }
  }, 800);
}
articleFieldEls.forEach((el) => el.addEventListener('input', scheduleDraftSave));

let clearAStatus;
function aFlash(msg, ok = true) {
  aStatus.textContent = msg;
  aStatus.style.color = ok ? 'var(--muted)' : 'var(--danger)';
  clearTimeout(clearAStatus);
  clearAStatus = setTimeout(() => (aStatus.textContent = ''), 2500);
}

async function saveArticle() {
  const f = articleFields();
  if (!f.title.trim()) {
    aTitle.focus();
    aFlash('Title is required', false);
    return;
  }
  if (!f.takeaway.trim()) {
    aTakeaway.focus();
    aFlash('Add a key takeaway before saving', false);
    return;
  }
  aSaveBtn.disabled = true;
  try {
    const { file } = await window.brain.saveArticle(f);
    fillArticle(null);
    aFlash(`Saved → ${file.split(/[\\/]/).pop()} ✓`);
  } catch (e) {
    aFlash('Failed to save: ' + (e && e.message ? e.message : e), false);
  } finally {
    aSaveBtn.disabled = false;
  }
}

async function clearArticle() {
  fillArticle(null);
  try {
    await window.brain.clearArticleDraft();
  } catch {
    /* non-fatal */
  }
  aFlash('Cleared');
  aTitle.focus();
}

aSaveBtn.addEventListener('click', saveArticle);
aClearBtn.addEventListener('click', clearArticle);

async function loadArticleDraft() {
  try {
    fillArticle(await window.brain.getArticleDraft());
  } catch {
    /* non-fatal */
  }
}

// ======================= init =======================
document.addEventListener('keydown', (e) => {
  const typing = document.activeElement === taskEl || document.activeElement === input || articleFieldEls.includes(document.activeElement);
  if (e.key === 'Escape' && !typing) {
    window.brain.hide();
  }
});

setMode('focus');
refreshNotes();
loadArticleDraft();
showView('notes');
