// Brücke zwischen Renderer und Hauptprozess (bewusst schmal gehalten).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, msg) => cb(msg);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openOutput: (displayId, outputName) => ipcRenderer.invoke('output:open', { displayId, outputName }),
  closeOutput: (displayId) => ipcRenderer.invoke('output:close', { displayId }),
  closeAllOutputs: () => ipcRenderer.invoke('output:closeAll'),
  openOutputIds: () => ipcRenderer.invoke('output:openIds'),
  broadcast: (msg) => ipcRenderer.send('state:broadcast', msg),
  sendOutputEvent: (msg) => ipcRenderer.send('output:event', msg),
  focusMain: () => ipcRenderer.send('output:focusMain'),
  readFile: (p, encoding) => ipcRenderer.invoke('file:read', p, encoding),
  writeFile: (p, data, encoding) => ipcRenderer.invoke('file:write', p, data, encoding),
  exists: (p) => ipcRenderer.invoke('file:exists', p),
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  paths: () => ipcRenderer.invoke('app:paths'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  oscSend: (host, port, address, args) => ipcRenderer.invoke('osc:send', { host, port, address, args }),
  onStateUpdate: on('state:update'),
  onOutputEvent: on('output:event'),
  onOutputConfig: on('output:config'),
  onOutputClosed: on('output:closed'),
  onMenu: on('menu'),
  onDisplaysChanged: on('displays:changed'),
});
