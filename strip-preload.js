'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strip', {
  onUsage: (cb) => ipcRenderer.on('usage:data', (_e, d) => cb(d)),
  onCap: (cb) => ipcRenderer.on('cap:state', (_e, s) => cb(s)),
  onOpen: (cb) => ipcRenderer.on('strip:open', (_e, o) => cb(o)),
  click: (kind, left) => ipcRenderer.send('strip:click', kind, left),
  menu: () => ipcRenderer.send('strip:menu'),
  ready: () => ipcRenderer.send('strip:ready'),
});
