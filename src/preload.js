const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brain', {
  appendNote: (text) => ipcRenderer.invoke('note:append', text),
  todayNotes: () => ipcRenderer.invoke('note:today'),
  hide: () => ipcRenderer.send('window:hide'),
});
