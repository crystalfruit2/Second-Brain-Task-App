const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brain', {
  appendNote: (text) => ipcRenderer.invoke('note:append', text),
  todayNotes: () => ipcRenderer.invoke('note:today'),
  logPomodoro: (session) => ipcRenderer.invoke('pomodoro:log', session),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  toggleTask: (item) => ipcRenderer.invoke('tasks:toggle', item),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  openDashboard: () => ipcRenderer.send('window:dashboard'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
  dock: (edge) => ipcRenderer.send('window:dock', edge),
});
