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

  // ---- Mission Control: Reading Room ----
  // sessions
  readerSessions: () => ipcRenderer.invoke('reader:sessions'),
  // -> [{ pid, sessionId, name, cwd, project, status: 'busy'|'idle'|'unknown', title }]
  readerOpen: (pid) => ipcRenderer.invoke('reader:open', pid),
  // -> { ok, pid, sessionId, title, status, turns: [Turn] } (opening another pid closes the previous reader)
  readerClose: () => ipcRenderer.invoke('reader:close'),
  onReaderTurns: (cb) => ipcRenderer.on('reader:turns', (_e, payload) => cb(payload)),
  // { pid, sessionId, turns } — appended OR re-sent turns; upsert by uuid
  onReaderStatus: (cb) => ipcRenderer.on('reader:status', (_e, payload) => cb(payload)),
  // { pid, sessionId, status, title, swapped? } — swapped = /clear happened
  // side thread
  askRocky: (payload) => ipcRenderer.invoke('reader:ask', payload),
  // { pid, threadId?, selection, turnUuid, question, fullContext? } -> { ok, threadId, jobId, mode, error? }
  // streaming arrives on onJobOutput / onJobUpdate for that jobId
  threadNote: (payload) => ipcRenderer.invoke('reader:note', payload), // { pid, threadId } -> { ok, file }
  threadSave: (payload) => ipcRenderer.invoke('reader:saveTopic', payload), // { pid, threadId, topicFile } -> { ok, file }
  listTopics: () => ipcRenderer.invoke('reader:topics'), // -> [{ file, title }] newest first
  // ---- Mission Control: note page (rocky://open?file=…) ----
  readNote: (rel) => ipcRenderer.invoke('note:read', rel),
  // -> { ok, rel, title, meta, md, mtime } | { ok:false, error }
  resolveNoteLink: (target) => ipcRenderer.invoke('note:resolveLink', target), // [[target]] -> rel | null
  openInObsidian: (rel) => ipcRenderer.invoke('note:openInObsidian', rel),
  onNoteOpen: (cb) => ipcRenderer.on('note:open', (_e, payload) => cb(payload)), // { file, heading }
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
