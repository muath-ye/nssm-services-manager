const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setNssmPath: (p) => ipcRenderer.invoke('config:set-nssm', p),
  browseNssm: () => ipcRenderer.invoke('dialog:browse-nssm'),
  listServices: () => ipcRenderer.invoke('services:list'),
  action: (name, action) => ipcRenderer.invoke('services:action', name, action),
  install: (payload) => ipcRenderer.invoke('services:install', payload),
  remove: (name) => ipcRenderer.invoke('services:remove', name),
  edit: (name) => ipcRenderer.invoke('services:edit', name),
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, value) => cb(value)),
});
