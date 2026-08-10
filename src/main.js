const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const vault = require('./vault');
const sessions = require('./sessions');

let notesWin = null;
let dashboardWin = null;
let tray = null;
let isQuitting = false;

// Sessions list is polled on an interval, but only while the Dashboard window
// is open and only that one dashboardWin gets pushed updates — a hidden/closed
// dashboard costs zero `ps`/`lsof` calls. 10s keeps it feeling live without
// spinning up shell processes needlessly on battery.
const SESSION_POLL_MS = 10_000;
let sessionPollTimer = null;

async function pollSessions() {
  if (!dashboardWin || dashboardWin.isDestroyed()) return;
  try {
    const list = await sessions.listSessions();
    if (dashboardWin && !dashboardWin.isDestroyed()) {
      dashboardWin.webContents.send('sessions:update', list);
    }
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
    title: 'Second Brain — Dashboard',
    backgroundColor: '#1c1c20',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWin.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  dashboardWin.webContents.once('did-finish-load', startSessionPolling);
  dashboardWin.on('closed', () => {
    dashboardWin = null;
    stopSessionPolling();
  });
}

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
  tray.setToolTip('Second Brain — Notes & Timer');
  const menu = Menu.buildFromTemplate([
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
ipcMain.handle('tasks:toggle', (_e, { file, line, raw }) => vault.toggleTaskLine(file, line, raw));
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

ipcMain.on('window:hide', () => {
  if (notesWin) notesWin.hide();
});
ipcMain.on('window:quit', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.on('window:dock', (_e, edge) => dockTo(edge));
ipcMain.on('window:dashboard', () => createDashboardWindow());

app.whenReady().then(() => {
  createTray();
  setDockMenu();
  createNotesWindow();
  notesWin.once('ready-to-show', () => notesWin.show());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createNotesWindow();
  });
});

// Keep running in the tray when the window is closed — only real quit exits.
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('before-quit', stopSessionPolling);
