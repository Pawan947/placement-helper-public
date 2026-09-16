const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Window
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),

    // Data
    getDrives: () => ipcRenderer.invoke('data:drives'),
    getNewDrives: () => ipcRenderer.invoke('data:newDrives'),
    getSorted: () => ipcRenderer.invoke('data:sorted'),
    getKnown: () => ipcRenderer.invoke('data:known'),
    getMyDrivesFull: () => ipcRenderer.invoke('data:myDrivesFull'),

    // Config
    loadConfig: () => ipcRenderer.invoke('config:load'),
    saveConfig: (data) => ipcRenderer.invoke('config:save', data),

    // Pipeline
    getStatus: () => ipcRenderer.invoke('pipeline:status'),
    runPipeline: (mode) => ipcRenderer.send('pipeline:run', mode),
    stopPipeline: () => ipcRenderer.send('pipeline:stop'),
    onLog: (cb) => ipcRenderer.on('pipeline:log', (_, msg) => cb(msg)),
    onStarted: (cb) => ipcRenderer.on('pipeline:started', () => cb()),
    onStopped: (cb) => ipcRenderer.on('pipeline:stopped', () => cb()),
    onRefresh: (cb) => ipcRenderer.on('pipeline:refresh', () => cb()),

    // Startup settings
    getStartupState: () => ipcRenderer.invoke('startup:get'),
    setStartupState: (enable) => ipcRenderer.invoke('startup:set', enable),

    // Drive registration
    registerDrive: (companyName) => ipcRenderer.invoke('drive:register', companyName),
    openPortal: (url) => ipcRenderer.invoke('portal:open', url),
});


