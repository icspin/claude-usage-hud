'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { UsageScanner } = require('./src/scanner');
const { aggregate } = require('./src/aggregate');
const { DEFAULT_PRICING } = require('./src/pricing');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const DEFAULT_SETTINGS = {
  bounds: { width: 420, height: 520 },
  idleOpacity: 0.55,
  pollIntervalMs: 5000,
  alwaysOnTop: true,
  launchAtLogin: false,
  pinned: false,
  pricing: null, // null = use DEFAULT_PRICING
};

let win = null;
let tray = null;
let settings = null;
let scanner = null;
let pollTimer = null;
let scanning = false;
let lastData = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch { /* non-fatal */ }
  }, 400);
}

function activePricing() {
  return settings.pricing || DEFAULT_PRICING;
}

async function poll() {
  if (scanning) return;
  scanning = true;
  try {
    const entries = await scanner.scan();
    const meta = scanner.readSessionMeta();
    lastData = aggregate(entries, meta, activePricing());
    if (win && !win.isDestroyed()) win.webContents.send('usage:data', lastData);
    updateTrayTooltip();
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.send('usage:error', String(err));
  } finally {
    scanning = false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, Math.max(2000, settings.pollIntervalMs));
  poll();
}

function fmtMoney(v) {
  return '$' + (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
}

function updateTrayTooltip() {
  if (!tray || !lastData) return;
  const t = lastData.totals;
  tray.setToolTip(
    `Claude Usage HUD\nToday: ${fmtMoney(t.today.cost)}  ·  Month: ${fmtMoney(t.month.cost)}` +
    (lastData.currentBlock ? `\n5h block: ${fmtMoney(lastData.currentBlock.cost)}` : '')
  );
}

function setPinned(pinned) {
  settings.pinned = pinned;
  saveSettings();
  if (!win || win.isDestroyed()) return;
  // forward:true keeps mousemove flowing to the page so hover-to-brighten still
  // works while clicks pass through to whatever is underneath.
  win.setIgnoreMouseEvents(pinned, { forward: true });
  win.webContents.send('hud:pinned', pinned);
  rebuildTrayMenu();
}

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 420,
    height: b.height || 520,
    x: b.x,
    y: b.y,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    minWidth: 280,
    minHeight: 200,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('closed', () => { win = null; });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('hud:settings', publicSettings());
    win.webContents.send('hud:pinned', settings.pinned);
    if (lastData) win.webContents.send('usage:data', lastData);
  });

  if (settings.pinned) win.setIgnoreMouseEvents(true, { forward: true });
}

function publicSettings() {
  return {
    idleOpacity: settings.idleOpacity,
    pollIntervalMs: settings.pollIntervalMs,
    alwaysOnTop: settings.alwaysOnTop,
    launchAtLogin: settings.launchAtLogin,
    pinned: settings.pinned,
    pricing: activePricing(),
    pricingIsCustom: !!settings.pricing,
    claudeDir: CLAUDE_DIR,
  };
}

function trayIcon() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16 });
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide HUD' : 'Show HUD', click: toggleWindow },
    {
      label: settings.pinned ? 'Unpin (make clickable)' : 'Pin (click-through)',
      click: () => setPinned(!settings.pinned),
    },
    { type: 'separator' },
    {
      label: 'Always on top', type: 'checkbox', checked: settings.alwaysOnTop,
      click: (item) => {
        settings.alwaysOnTop = item.checked;
        saveSettings();
        if (win) win.setAlwaysOnTop(item.checked, 'screen-saver');
      },
    },
    {
      label: 'Launch at login', type: 'checkbox', checked: settings.launchAtLogin,
      click: (item) => {
        settings.launchAtLogin = item.checked;
        saveSettings();
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    { label: 'Rescan now', click: poll },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function toggleWindow() {
  if (!win || win.isDestroyed()) { createWindow(); rebuildTrayMenu(); return; }
  if (win.isVisible()) win.hide(); else win.show();
  rebuildTrayMenu();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    settings = loadSettings();
    scanner = new UsageScanner(CLAUDE_DIR);

    createWindow();

    tray = new Tray(trayIcon() || nativeImage.createEmpty());
    tray.setToolTip('Claude Usage HUD');
    tray.on('click', toggleWindow);
    rebuildTrayMenu();

    // Ctrl+Alt+U toggles pin even when the window is click-through.
    globalShortcut.register('Control+Alt+U', () => setPinned(!settings.pinned));

    startPolling();
  });
}

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---- IPC ----
ipcMain.handle('usage:get', () => lastData);
ipcMain.handle('hud:getSettings', () => publicSettings());

ipcMain.on('hud:setPinned', (_e, pinned) => setPinned(!!pinned));
ipcMain.on('hud:hide', () => { if (win) win.hide(); rebuildTrayMenu(); });

ipcMain.on('hud:updateSettings', (_e, patch) => {
  const restartPoll = patch.pollIntervalMs && patch.pollIntervalMs !== settings.pollIntervalMs;
  Object.assign(settings, patch);
  saveSettings();
  if (patch.alwaysOnTop !== undefined && win) win.setAlwaysOnTop(!!patch.alwaysOnTop, 'screen-saver');
  if (patch.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
  if (restartPoll) startPolling();
  if (patch.pricing !== undefined) poll(); // recompute costs with new rates
  if (win && !win.isDestroyed()) win.webContents.send('hud:settings', publicSettings());
  rebuildTrayMenu();
});

ipcMain.on('hud:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// Drag-anywhere: the renderer reports mousedown on non-interactive areas; we
// follow the cursor until mouseup. A 3px threshold keeps plain clicks put.
let drag = null;
ipcMain.on('hud:dragStart', () => {
  if (!win || win.isDestroyed() || drag) return;
  const { screen } = require('electron');
  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  drag = {
    cx: pt.x, cy: pt.y, wx: b.x, wy: b.y, moved: false,
    timer: setInterval(() => {
      if (!drag || !win || win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const dx = p.x - drag.cx;
      const dy = p.y - drag.cy;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      drag.moved = true;
      win.setPosition(drag.wx + dx, drag.wy + dy);
    }, 16),
  };
});
ipcMain.on('hud:dragEnd', () => {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (win && !win.isDestroyed()) {
    settings.bounds = win.getBounds();
    saveSettings();
  }
});
