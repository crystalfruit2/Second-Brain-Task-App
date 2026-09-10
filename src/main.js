const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const vault = require('./vault');
const sessions = require('./sessions');
const rocky = require('./rocky');
const reader = require('./reader');
const { VAULT_PATH } = require('./config');
const { parseRockyUrl } = require('./deeplink');

let notesWin = null;
let dashboardWin = null;
let missionWin = null;
let tray = null;
let isQuitting = false;

// Sessions list is polled on an interval, but only while a window that shows
// sessions (Dashboard or Mission Control) is actually open — with both closed
// this costs zero `ps`/`lsof` calls. 10s keeps it feeling live without spinning
// up shell processes needlessly on battery.
const SESSION_POLL_MS = 10_000;
let sessionPollTimer = null;

// Every open window that wants the live session list. Mission Control shows the
// same data as the Dashboard's Sessions panel, so they share one poll rather
// than each running their own ps/lsof pass.
function sessionSubscribers() {
  return [dashboardWin, missionWin].filter((w) => w && !w.isDestroyed());
}

async function pollSessions() {
  if (!sessionSubscribers().length) return stopSessionPolling();
  try {
    const list = await sessions.listSessions();
    for (const w of sessionSubscribers()) w.webContents.send('sessions:update', list);
  } catch {
    /* non-fatal — next tick tries again */
  }
}

function startSessionPolling() {
  if (sessionPollTimer) return;
  pollSessions();
  sessionPollTimer = setInterval(pollSessions, SESSION_POLL_MS);
}

function stopSessionPolling() {
  clearInterval(sessionPollTimer);
  sessionPollTimer = null;
}

// Rocky job events are push-only — a spawned child process's stdout/close
// events, never a timer. They only go to Mission Control, which is the one
// window that renders them.
rocky.configure({
  historyFile: path.join(app.getPath('userData'), 'rocky-jobs.json'),
  onEvent: (kind, payload) => {
    if (missionWin && !missionWin.isDestroyed()) {
      missionWin.webContents.send(kind === 'output' ? 'rocky:output' : 'rocky:job', payload);
    }
  },
});

// Reading Room events are push-only as well — fs.watch on one transcript and
// on ~/.claude/sessions, nothing else — and only exist while a reader is open.
reader.configure({
  vaultPath: VAULT_PATH,
  onEvent: (kind, payload) => {
    if (missionWin && !missionWin.isDestroyed()) {
      missionWin.webContents.send(`reader:${kind}`, payload);
    }
  },
});

// Nothing in this app is supposed to open a second window or navigate away from
// its own local file — every renderer is a static page over IPC. Vault content
// is rendered as text, but it *is* untrusted-ish input (a note could contain a
// stray `<a href>` or an `http-equiv=refresh`), so both escape hatches are shut
// on every window rather than trusted not to be found.
function lockDownNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

// Compact "perfect" defaults. Float = card in the top-right; docked sizes below.
const FLOAT = { width: 340, height: 480 };
const SIDE_W = 340; // width when docked to a left/right edge (full-height panel)
const BAR_H = 340; // height when docked to top/bottom (centered card flush to edge)

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(partial) {
  const prev = readState() || {};
  const next = { ...prev, ...partial };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch {
    /* non-fatal */
  }
}

// The one session whose checklist the widget's Tasks tab currently shows —
// a UI preference (which terminal am I following right now), not vault
// content, so it lives in the same app-local window-state.json as window
// bounds/dock edge rather than anywhere in the vault. Set by clicking a
// session card in the Dashboard; the widget (if open) gets pushed the change
// live so switching sessions from the Dashboard updates the Tasks tab
// immediately without a manual refresh.
function getActiveSession() {
  const st = readState();
  return (st && st.activeSession) || null;
}

function setActiveSession(slug, name) {
  const value = slug ? { slug, name: name || slug } : null;
  saveState({ activeSession: value });
  if (notesWin && !notesWin.isDestroyed()) {
    notesWin.webContents.send('session:activeChanged', value);
  }
  return value;
}

// Compute flush-to-edge bounds within the work area of the display the window is on.
function boundsForDock(edge) {
  const base = notesWin ? notesWin.getBounds() : { x: 0, y: 0 };
  const disp = screen.getDisplayNearestPoint(base);
  const wa = disp.workArea; // excludes taskbar
  switch (edge) {
    case 'left':
      return { x: wa.x, y: wa.y, width: SIDE_W, height: wa.height };
    case 'right':
      return { x: wa.x + wa.width - SIDE_W, y: wa.y, width: SIDE_W, height: wa.height };
    case 'top':
      return {
        x: wa.x + Math.round((wa.width - FLOAT.width) / 2),
        y: wa.y,
        width: FLOAT.width,
        height: BAR_H,
      };
    case 'bottom':
      return {
        x: wa.x + Math.round((wa.width - FLOAT.width) / 2),
        y: wa.y + wa.height - BAR_H,
        width: FLOAT.width,
        height: BAR_H,
      };
    case 'float':
    default:
      return {
        x: wa.x + wa.width - FLOAT.width - 20,
        y: wa.y + 40,
        width: FLOAT.width,
        height: FLOAT.height,
      };
  }
}

function dockTo(edge) {
  if (!notesWin) return;
  const b = boundsForDock(edge);
  notesWin.setBounds(b, true);
  saveState({ dock: edge, bounds: b });
}

function createNotesWindow() {
  const st = readState();
  const startBounds = st && st.bounds ? st.bounds : boundsForDock('float');

  notesWin = new BrowserWindow({
    ...startBounds,
    icon: ICON_PATH,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    minWidth: 260,
    minHeight: 300,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Float above fullscreen apps too (e.g. a maximized PDF reader).
  notesWin.setAlwaysOnTop(true, 'screen-saver');
  notesWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  lockDownNavigation(notesWin);
  notesWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Remember where the user leaves it (debounced).
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (notesWin && !notesWin.isDestroyed()) saveState({ bounds: notesWin.getBounds() });
    }, 400);
  };
  notesWin.on('move', remember);
  notesWin.on('resize', remember);

  notesWin.on('closed', () => {
    notesWin = null;
  });
}

function showWindow() {
  if (!notesWin) createNotesWindow();
  if (notesWin.isVisible()) {
    notesWin.focus();
  } else {
    notesWin.show();
    notesWin.focus();
  }
}

function toggleNotesWindow() {
  if (notesWin && notesWin.isVisible()) {
    notesWin.hide();
  } else {
    showWindow();
  }
}

function createDashboardWindow() {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show();
    dashboardWin.focus();
    return;
  }
  dashboardWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    icon: ICON_PATH,
    title: 'Rocky OS — Dashboard',
    backgroundColor: '#1c1c20',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownNavigation(dashboardWin);
  dashboardWin.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  dashboardWin.webContents.once('did-finish-load', startSessionPolling);
  dashboardWin.on('closed', () => {
    dashboardWin = null;
    if (!sessionSubscribers().length) stopSessionPolling();
  });
}

// Mission Control — the OS screen. This is what opens on launch now; the Notes
// widget went back to being tray/Dock-summoned, since the thing I actually want
// in front of me when the app starts is the state of everything plus a place to
// dispatch work, not an empty capture box.
function createMissionWindow() {
  if (missionWin && !missionWin.isDestroyed()) {
    missionWin.show();
    missionWin.focus();
    return;
  }
  missionWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    icon: ICON_PATH,
    title: 'Rocky OS — Mission Control',
    backgroundColor: '#000000',
    show: false,
    // macOS: traffic lights float over the board's own header (dragging is
    // handled by -webkit-app-region on the header). Windows keeps its frame.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownNavigation(missionWin);
  missionWin.loadFile(path.join(__dirname, 'renderer', 'mission-control.html'));
  missionWin.once('ready-to-show', () => missionWin.show());
  missionWin.webContents.once('did-finish-load', startSessionPolling);
  // Dev-only screenshot mode: MC_CAPTURE=<outdir> renders the board against the
  // real vault, captures 1280×800 + 900×560, then quits. Never runs in prod.
  if (process.env.MC_CAPTURE && !process.env.ROCKY_OPEN_URL) {
    missionWin.webContents.once('did-finish-load', async () => {
      const fsp = require('fs').promises;
      const out = process.env.MC_CAPTURE;
      await fsp.mkdir(out, { recursive: true });
      const shoot = async (w, h, name) => {
        missionWin.setSize(w, h);
        await new Promise((r) => setTimeout(r, 900));
        const img = await missionWin.webContents.capturePage();
        await fsp.writeFile(path.join(out, name), img.toPNG());
      };
      const js = (code) =>
        missionWin.webContents
          .executeJavaScript(code)
          .catch((e) => console.error('MC_CAPTURE js failed:', e));
      await new Promise((r) => setTimeout(r, 2200)); // let vault loads settle
      await shoot(1280, 800, 'desktop.png');
      await shoot(900, 560, 'user-900.png');
      missionWin.setSize(1280, 800);
      await js(`const c = document.getElementById('cmd'); c.value = '/start-day'; c.dispatchEvent(new Event('input'));`);
      await shoot(1280, 800, 'armed.png');
      await js(`document.getElementById('cmd').value = ''; document.getElementById('cmd').dispatchEvent(new Event('input')); document.getElementById('tasks-head').click();`);
      await shoot(1280, 800, 'page-day.png');
      await js(`document.getElementById('instr-threads').click();`);
      await shoot(1280, 800, 'page-threads.png');
      app.quit();
    });
  }
  missionWin.on('closed', () => {
    missionWin = null;
    // No window, no reader: drop the transcript watch so a closed Mission
    // Control costs nothing while the terminals keep writing.
    reader.close();
    if (!sessionSubscribers().length) stopSessionPolling();
  });
}

// ---- rocky:// deep links ----
// `rocky://open?file=<vault-relative path>` opens that note on Mission
// Control's center display. Claude prints these next to every vault path it
// names in the terminal (Cmd+double-click in Terminal.app), so the note lands
// here instead of being copy-pasted into Finder. Registration only happens in
// packaged builds: `electron .` would otherwise steal the scheme from the
// installed app for the whole machine.
//
// macOS delivers the URL via `open-url` (possibly before `ready`, possibly to
// an already-running instance — the single-instance lock keeps it one app).
// Windows/Linux deliver it as an argv entry of a *second* instance, which the
// lock forwards to us as `second-instance`.
let pendingDeepLink = null;

function handleDeepLink(raw) {
  const link = parseRockyUrl(raw);
  if (!link) return false;
  if (!app.isReady()) {
    pendingDeepLink = raw;
    return true;
  }
  if (link.kind === 'file') {
    // Attachment (xlsx/pdf/png…): nothing to render in-app — open it with the
    // OS default app, but only if it really lives inside the vault.
    let abs;
    try {
      abs = assertInVault(path.join(VAULT_PATH, link.file));
    } catch {
      return true;
    }
    if (!fs.existsSync(abs)) {
      dialog.showErrorBox('Rocky OS', `Vault'ta böyle bir dosya yok:\n${link.file}`);
      return true;
    }
    shell.openPath(abs).then((err) => {
      if (err) dialog.showErrorBox('Rocky OS', `Dosya açılamadı: ${err}`);
    });
    return true;
  }
  createMissionWindow();
  const deliver = () => {
    if (!missionWin || missionWin.isDestroyed()) return;
    missionWin.webContents.send('note:open', { file: link.file, heading: link.heading });
    if (missionWin.isMinimized()) missionWin.restore();
    missionWin.show();
    // Activation has to happen on a later tick: called synchronously inside
    // `open-url` macOS ignores it and the terminal keeps the foreground.
    setTimeout(() => {
      if (!missionWin || missionWin.isDestroyed()) return;
      app.focus({ steal: true });
      missionWin.focus();
    }, 60);
  };
  if (missionWin.webContents.isLoadingMainFrame()) missionWin.webContents.once('did-finish-load', deliver);
  else deliver();
  return true;
}

function deepLinkInArgv(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith('rocky://')) || null;
}

// Both are packaged-only: `electron .` shares userData with the installed app,
// so a dev lock would just make the dev instance exit while Rocky OS is up.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient('rocky');
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      const url = deepLinkInArgv(argv);
      if (url) handleDeepLink(url);
      else createMissionWindow();
    });
  }
}

app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

const PIN_SCRIPT = path.join(__dirname, 'native', 'pin-window.ps1');
const IS_WINDOWS = process.platform === 'win32';

// Toggle Windows "always on top" for the window whose title matches (default: Claude).
// Runs the bundled PowerShell/Win32 helper out-of-process; resolves to 'PINNED' | 'UNPINNED' | 'NOTFOUND'.
// Win32's SetWindowPos(HWND_TOPMOST) has no macOS equivalent reachable from AppleScript/System Events,
// so this feature is Windows-only; the tray item is hidden on Mac rather than silently failing.
function pinExternalWindow(titleMatch = 'Claude') {
  if (!IS_WINDOWS) return Promise.resolve('UNSUPPORTED');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PIN_SCRIPT, '-TitleMatch', titleMatch],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('NOTFOUND');
        resolve(stdout.trim());
      }
    );
  });
}

function makeTrayIcon() {
  const img = nativeImage.createFromPath(ICON_PATH);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Rocky OS — Notes & Timer');
  const menu = Menu.buildFromTemplate([
    { label: 'Mission Control', click: createMissionWindow },
    { label: 'Show / hide notes', click: toggleNotesWindow },
    { label: 'Dashboard', click: createDashboardWindow },
    ...(IS_WINDOWS ? [{ label: 'Pin Claude on top', click: () => pinExternalWindow('Claude') }] : []),
    {
      label: 'Dock',
      submenu: [
        { label: 'Left edge', click: () => dockTo('left') },
        { label: 'Right edge', click: () => dockTo('right') },
        { label: 'Top edge', click: () => dockTo('top') },
        { label: 'Bottom edge', click: () => dockTo('bottom') },
        { type: 'separator' },
        { label: 'Float (top-right)', click: () => dockTo('float') },
      ],
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleNotesWindow);
}

// Right-click-on-Dock-icon menu, mirroring the tray menu's two most-used items.
// Mac-only — Menu.app.dock doesn't exist on other platforms.
function setDockMenu() {
  if (process.platform !== 'darwin') return;
  app.dock.setMenu(
    Menu.buildFromTemplate([
      { label: 'Mission Control', click: createMissionWindow },
      { label: 'Show / hide notes', click: toggleNotesWindow },
      { label: 'Dashboard', click: createDashboardWindow },
    ])
  );
}

// ---- IPC: renderer -> main ----
ipcMain.handle('note:append', (_e, text) => vault.appendNote(text));
ipcMain.handle('note:today', () => vault.readTodayNotes());
ipcMain.handle('pomodoro:log', (_e, session) => vault.appendPomodoroSession(session));
ipcMain.handle('tasks:list', () => vault.listTasks());
// The renderer hands back the same `file` it was given, but this is still the
// one IPC call that writes to an arbitrary path, so it only ever gets to write
// inside the vault.
function assertInVault(file) {
  const resolved = path.resolve(String(file || ''));
  const root = path.resolve(VAULT_PATH);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to write outside the vault.');
  }
  return resolved;
}

ipcMain.handle('tasks:toggle', (_e, { file, line, raw }) =>
  vault.toggleTaskLine(assertInVault(file), line, raw)
);
ipcMain.handle('projects:list', () => vault.listProjects());
ipcMain.handle('sessions:list', () => sessions.listSessions());
ipcMain.handle('session:notesGet', (_e, slug) => vault.readSessionNotes(slug));
ipcMain.handle('session:notesSave', (_e, { slug, name, text }) => vault.saveSessionNotes(slug, name, text));
ipcMain.handle('session:getActive', () => getActiveSession());
ipcMain.handle('session:setActive', (_e, { slug, name }) => setActiveSession(slug, name));
ipcMain.handle('session:taskItems', (_e, slug) => vault.listSessionTaskItems(slug));
ipcMain.handle('window:pinClaude', () => pinExternalWindow('Claude'));
ipcMain.handle('health:cigCount', () => vault.getCigCount());
ipcMain.handle('health:cigLog', (_e, delta) => vault.logCigarette(delta));
ipcMain.handle('article:save', (_e, data) => vault.saveArticleNote(data));
ipcMain.handle('article:draftGet', () => vault.readArticleDraft());
ipcMain.handle('article:draftSave', (_e, draft) => vault.saveArticleDraft(draft));
ipcMain.handle('article:draftClear', () => {
  vault.clearArticleDraft();
  return true;
});

// ---- IPC: Mission Control panels (all read-only vault views) ----
ipcMain.handle('mc:todayTasks', () => vault.listTodayTasks());
ipcMain.handle('mc:projects', () => vault.listProjectsBrief());
ipcMain.handle('mc:lifeThreads', () => vault.listLifeThreads());
ipcMain.handle('mc:inbox', () => vault.readInbox());
ipcMain.handle('mc:health', () => vault.readHealth());
ipcMain.handle('mc:reviewsDue', () => vault.reviewsDue());
ipcMain.handle('mc:agenda', () => vault.readAgenda());

// ---- IPC: note page (deep-linked vault notes) ----
ipcMain.handle('note:read', (_e, rel) => vault.readNote(rel));
ipcMain.handle('note:resolveLink', (_e, target) => vault.resolveWikilink(target));
// The only outbound navigation this app makes: hand the same note to Obsidian.
// Vault name = folder name; `assertInVault` keeps the target a real vault path.
ipcMain.handle('note:openInObsidian', (_e, rel) => {
  const abs = assertInVault(path.join(VAULT_PATH, String(rel || '')));
  const relClean = path.relative(VAULT_PATH, abs).split(path.sep).join('/').replace(/\.md$/i, '');
  const q = new URLSearchParams({ vault: path.basename(VAULT_PATH), file: relClean });
  return shell.openExternal(`obsidian://open?${q.toString()}`).then(() => true);
});

// ---- IPC: Rocky jobs ----
// cwd is always the vault root so the vault's CLAUDE.md, skills and hooks are
// in play — the whole point is that this dispatches to *my* Rocky, not a
// context-free agent.
ipcMain.handle('rocky:dispatch', (_e, { prompt, label }) =>
  rocky.dispatch({ prompt, label, cwd: VAULT_PATH })
);
ipcMain.handle('rocky:terminal', (_e, { prompt }) =>
  rocky.openInTerminal({ prompt, cwd: VAULT_PATH })
);
ipcMain.handle('rocky:jobs', () => rocky.listJobs());
ipcMain.handle('rocky:kill', (_e, id) => rocky.killJob(id));

// ---- IPC: Reading Room ----
// Side-thread answers stream over the same rocky:output / rocky:job channels
// as every other job; the renderer filters by the jobId reader:ask returned.
ipcMain.handle('reader:sessions', () => reader.listSessions());
ipcMain.handle('reader:open', (_e, pid) => reader.open(pid));
ipcMain.handle('reader:close', () => reader.close());
ipcMain.handle('reader:ask', (_e, payload) => reader.ask(payload || {}));
ipcMain.handle('reader:note', (_e, payload) => reader.note(payload || {}));
ipcMain.handle('reader:saveTopic', (_e, payload) => reader.saveTopic(payload || {}));
ipcMain.handle('reader:topics', () => reader.listTopics());

ipcMain.on('window:hide', () => {
  if (notesWin) notesWin.hide();
});
ipcMain.on('window:quit', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.on('window:dock', (_e, edge) => dockTo(edge));
ipcMain.on('window:dashboard', () => createDashboardWindow());
ipcMain.on('window:missionControl', () => createMissionWindow());

app.whenReady().then(() => {
  createTray();
  setDockMenu();
  // The widget is still created up front so the tray toggle is instant, but it
  // no longer shows itself — Mission Control is the launch screen now.
  createNotesWindow();
  createMissionWindow();

  // Dock click. The `getAllWindows().length === 0` guard every Electron sample
  // uses is wrong for this app: the Notes widget is always alive (hidden), so
  // the count is never 0 and clicking the Dock icon after closing Mission
  // Control did nothing at all. createMissionWindow() already shows/focuses an
  // existing window, so calling it unconditionally is the right behavior.
  app.on('activate', () => createMissionWindow());

  // A deep link that arrived before `ready` (cold launch from a terminal click),
  // or came in via argv on Windows/Linux.
  const bootLink = pendingDeepLink || deepLinkInArgv(process.argv);
  pendingDeepLink = null;
  if (bootLink) handleDeepLink(bootLink);

  // Dev-only: ROCKY_OPEN_URL=<rocky://…> opens that link once the board is up;
  // with MC_CAPTURE=<outdir> too, screenshots the result and quits.
  if (process.env.ROCKY_OPEN_URL && missionWin) {
    missionWin.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      handleDeepLink(process.env.ROCKY_OPEN_URL);
      if (!process.env.MC_CAPTURE) return;
      await new Promise((r) => setTimeout(r, 1500));
      const fsp = require('fs').promises;
      await fsp.mkdir(process.env.MC_CAPTURE, { recursive: true });
      const img = await missionWin.webContents.capturePage();
      await fsp.writeFile(path.join(process.env.MC_CAPTURE, 'deeplink.png'), img.toPNG());
      app.quit();
    });
  }
});

// Keep running in the tray when the window is closed — only real quit exits.
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('before-quit', () => {
  stopSessionPolling();
  reader.close();
  // Don't leave orphaned `claude` processes behind when the app goes away.
  rocky.killAll();
});
