const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const vault = require('./vault');

let notesWin = null;
let tray = null;

function createNotesWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  notesWin = new BrowserWindow({
    width: 340,
    height: 460,
    x: width - 360,
    y: 40,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    minWidth: 260,
    minHeight: 240,
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

  notesWin.on('closed', () => {
    notesWin = null;
  });
}

function toggleNotesWindow() {
  if (!notesWin) {
    createNotesWindow();
    notesWin.once('ready-to-show', () => notesWin.show());
    return;
  }
  if (notesWin.isVisible()) {
    notesWin.hide();
  } else {
    notesWin.show();
    notesWin.focus();
  }
}

function makeTrayIcon() {
  // Simple 16x16 dot so we don't depend on an external asset file.
  const img = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAT0lEQVR42mNkYGD4z0AEYBxVSFJhamr6z8DAwPD//38GYgFRLmBkZGQghqOxsbFEuwABYWBg+H8GBgYGRkYGYgFRLhg1YNSAUQNGDQAAqhwUAYy2i3wAAAAASUVORK5CYII='
  );
  return img;
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Second Brain — Notes');
  const menu = Menu.buildFromTemplate([
    { label: 'Show / hide notes', click: toggleNotesWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleNotesWindow);
}

// ---- IPC: renderer -> vault ----
ipcMain.handle('note:append', (_e, text) => {
  return vault.appendNote(text);
});

ipcMain.handle('note:today', () => {
  return vault.readTodayNotes();
});

ipcMain.on('window:hide', () => {
  if (notesWin) notesWin.hide();
});

app.whenReady().then(() => {
  createTray();
  createNotesWindow();
  notesWin.once('ready-to-show', () => notesWin.show());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createNotesWindow();
  });
});

// Keep running in the tray when the window is closed.
app.on('window-all-closed', (e) => {
  // Do not quit; the tray keeps the app alive.
});
