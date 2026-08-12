'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  getData: () => ipcRenderer.invoke('usage:get'),
  getSettings: () => ipcRenderer.invoke('hud:getSettings'),
  onData: (cb) => ipcRenderer.on('usage:data', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('usage:error', (_e, msg) => cb(msg)),
  onPinned: (cb) => ipcRenderer.on('hud:pinned', (_e, pinned) => cb(pinned)),
  onSettings: (cb) => ipcRenderer.on('hud:settings', (_e, s) => cb(s)),
  setPinned: (pinned) => ipcRenderer.send('hud:setPinned', pinned),
  hide: () => ipcRenderer.send('hud:hide'),
  updateSettings: (patch) => ipcRenderer.send('hud:updateSettings', patch),
  openExternal: (url) => ipcRenderer.send('hud:openExternal', url),
});
