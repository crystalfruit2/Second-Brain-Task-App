const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const status = document.getElementById('status');
const list = document.getElementById('list');
const dateEl = document.getElementById('date');
const hideBtn = document.getElementById('hide');

dateEl.textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

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
    // Split "HH:MM — text" so we can style the time.
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

async function refresh() {
  try {
    const notes = await window.brain.todayNotes();
    renderNotes(notes);
  } catch (e) {
    // non-fatal
  }
}

let clearStatus;
function flash(msg, ok = true) {
  status.textContent = msg;
  status.style.color = ok ? 'var(--muted)' : '#ff8080';
  clearTimeout(clearStatus);
  clearStatus = setTimeout(() => (status.textContent = ''), 2500);
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  try {
    await window.brain.appendNote(text);
    input.value = '';
    flash('Saved to today’s note ✓');
    await refresh();
  } catch (e) {
    flash('Failed to save: ' + (e && e.message ? e.message : e), false);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.addEventListener('click', send);
hideBtn.addEventListener('click', () => window.brain.hide());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
  if (e.key === 'Escape') {
    window.brain.hide();
  }
});

refresh();
input.focus();
