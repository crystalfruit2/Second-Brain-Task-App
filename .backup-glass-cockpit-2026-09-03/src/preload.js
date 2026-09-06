const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('brain', {
  platform: process.platform, // 'darwin' | 'win32' | ... — lets renderer hide Windows-only UI on Mac
  appendNote: (text) => ipcRenderer.invoke('note:append', text),
  todayNotes: () => ipcRenderer.invoke('note:today'),
  logPomodoro: (session) => ipcRenderer.invoke('pomodoro:log', session),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  toggleTask: (item) => ipcRenderer.invoke('tasks:toggle', item),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  onSessionsUpdate: (cb) => ipcRenderer.on('sessions:update', (_e, list) => cb(list)),
  getSessionNotes: (slug) => ipcRenderer.invoke('session:notesGet', slug),
  saveSessionNotes: (payload) => ipcRenderer.invoke('session:notesSave', payload),
  getActiveSession: () => ipcRenderer.invoke('session:getActive'),
  setActiveSession: (slug, name) => ipcRenderer.invoke('session:setActive', { slug, name }),
  onActiveSessionChanged: (cb) => ipcRenderer.on('session:activeChanged', (_e, value) => cb(value)),
  sessionTaskItems: (slug) => ipcRenderer.invoke('session:taskItems', slug),
  openDashboard: () => ipcRenderer.send('window:dashboard'),
  openMissionControl: () => ipcRenderer.send('window:missionControl'),

  // ---- Mission Control: read-only vault panels ----
  todayTasks: () => ipcRenderer.invoke('mc:todayTasks'),
  // Same rows as listProjects(), status trimmed to one short line — the panel
  // clamps it anyway and the registry's cells run to kilobytes of prose.
  projectsBrief: () => ipcRenderer.invoke('mc:projects'),
  lifeThreads: () => ipcRenderer.invoke('mc:lifeThreads'),
  inbox: () => ipcRenderer.invoke('mc:inbox'),
  health: () => ipcRenderer.invoke('mc:health'),
  reviewsDue: () => ipcRenderer.invoke('mc:reviewsDue'),
  agenda: () => ipcRenderer.invoke('mc:agenda'),

  // ---- Mission Control: Rocky jobs ----
  dispatchJob: (prompt, label) => ipcRenderer.invoke('rocky:dispatch', { prompt, label }),
  dispatchInTerminal: (prompt) => ipcRenderer.invoke('rocky:terminal', { prompt }),
  listJobs: () => ipcRenderer.invoke('rocky:jobs'),
  killJob: (id) => ipcRenderer.invoke('rocky:kill', id),
  onJobUpdate: (cb) => ipcRenderer.on('rocky:job', (_e, job) => cb(job)),
  onJobOutput: (cb) => ipcRenderer.on('rocky:output', (_e, chunk) => cb(chunk)),
  pinClaude: () => ipcRenderer.invoke('window:pinClaude'),
  cigCount: () => ipcRenderer.invoke('health:cigCount'),
  logCig: (delta) => ipcRenderer.invoke('health:cigLog', delta),
  saveArticle: (data) => ipcRenderer.invoke('article:save', data),
  getArticleDraft: () => ipcRenderer.invoke('article:draftGet'),
  saveArticleDraft: (draft) => ipcRenderer.invoke('article:draftSave', draft),
  clearArticleDraft: () => ipcRenderer.invoke('article:draftClear'),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
  dock: (edge) => ipcRenderer.send('window:dock', edge),
});
