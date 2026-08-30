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
  setCompact: (compact) => ipcRenderer.send('hud:setCompact', compact),
  reportHeight: (h) => ipcRenderer.send('hud:reportHeight', h),
  onHover: (cb) => ipcRenderer.on('hud:hover', (_e, inside) => cb(inside)),
  onWinSize: (cb) => ipcRenderer.on('hud:winsize', (_e, width) => cb(width)),
  onUnpinProgress: (cb) => ipcRenderer.on('hud:unpinProgress', (_e, p) => cb(p)),
  reportPinRect: (r) => ipcRenderer.send('hud:pinRect', r),
  setOpacityLive: (v) => ipcRenderer.send('hud:opacityLive', v),
  endOpacityDrag: () => ipcRenderer.send('hud:opacityEnd'),
  hide: () => ipcRenderer.send('hud:hide'),
  updateSettings: (patch) => ipcRenderer.send('hud:updateSettings', patch),
  openExternal: (url) => ipcRenderer.send('hud:openExternal', url),
});
