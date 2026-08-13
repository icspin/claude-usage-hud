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
  fullBounds: null,
  compact: true,
  idleOpacity: 0.55,
  pollIntervalMs: 5000,
  alwaysOnTop: true,
  launchAtLogin: false,
  pinned: false,
  pricing: null, // null = use DEFAULT_PRICING
  planPrice: 200, // monthly subscription price for the savings line; 0 hides it
  planName: 'Max 20x',
};

const COMPACT_HEIGHT = 222;

let win = null;
let tray = null;
let settings = null;
let scanner = null;
let pollTimer = null;
let scanning = false;
let lastData = null;
let lastLimits = null;
let limitsTimer = null;
let hoverTimer = null;
let hoverState = false;

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

function pushData() {
  if (win && !win.isDestroyed() && lastData) {
    win.webContents.send('usage:data', { ...lastData, limits: lastLimits });
  }
}

async function poll() {
  if (scanning) return;
  scanning = true;
  try {
    const entries = await scanner.scan();
    const meta = scanner.readSessionMeta();
    lastData = aggregate(entries, meta, activePricing());
    pushData();
    updateTrayTooltip();
  } catch (err) {
    if (win && !win.isDestroyed()) win.webContents.send('usage:error', String(err));
  } finally {
    scanning = false;
  }
}

// ---- official rate-limit utilization (same source as Claude Code's /usage) ----
// Works whenever ~/.claude/.credentials.json holds a fresh OAuth token (the
// claude CLI refreshes it whenever it runs). Degrades gracefully on 401.
function parseLimits(json) {
  const windows = [];
  // Preferred: the `limits` array — it includes model-scoped weekly limits
  // (e.g. a separate Fable cap) that the legacy top-level keys don't carry.
  if (json && Array.isArray(json.limits)) {
    for (const l of json.limits) {
      if (typeof l.percent !== 'number') continue;
      let label;
      if (l.kind === 'session') label = 'Session (5h)';
      else if (l.kind === 'weekly_all') label = 'Week (all models)';
      else if (l.scope && l.scope.model && l.scope.model.display_name) label = `Week (${l.scope.model.display_name})`;
      else label = l.kind;
      windows.push({
        key: l.kind + (label || ''),
        label,
        pct: Math.max(0, Math.min(100, l.percent)),
        resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
        severity: l.severity || 'normal',
      });
    }
    if (windows.length) return windows;
  }
  // Fallback: legacy top-level keys.
  const map = {
    five_hour: 'Session (5h)',
    seven_day: 'Week (all models)',
    seven_day_opus: 'Week (Opus)',
    seven_day_sonnet: 'Week (Sonnet)',
  };
  for (const [key, label] of Object.entries(map)) {
    const w = json && json[key];
    if (w && typeof w.utilization === 'number') {
      windows.push({
        key,
        label,
        pct: Math.max(0, Math.min(100, w.utilization)),
        resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
        severity: 'normal',
      });
    }
  }
  return windows;
}

let limitsBackoffUntil = 0;
let limitsBackoffMin = 0;
let lastCredMtime = 0;

async function fetchLimits() {
  if (Date.now() < limitsBackoffUntil) return;
  try {
    const credPath = path.join(CLAUDE_DIR, '.credentials.json');
    const raw = fs.readFileSync(credPath, 'utf8');
    const cred = JSON.parse(raw).claudeAiOauth;
    if (!cred || !cred.accessToken) throw new Error('no OAuth credentials');
    // Don't spend a request on a token we can already see is expired — it
    // can't succeed, and failed calls still count against the rate limit.
    if (cred.expiresAt && Date.now() >= cred.expiresAt) throw new Error('token expired');
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (res.status === 429) {
      // Escalating backoff: 15 → 30 → 60 min, so a sustained limit doesn't
      // keep us knocking every quarter hour.
      limitsBackoffMin = Math.min(60, limitsBackoffMin ? limitsBackoffMin * 2 : 15);
      limitsBackoffUntil = Date.now() + limitsBackoffMin * 60 * 1000;
      throw new Error('HTTP 429');
    }
    limitsBackoffMin = 0;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const windows = parseLimits(await res.json());
    lastLimits = { ok: true, fetchedAt: Date.now(), windows, subscriptionType: cred.subscriptionType || null };
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'limits-cache.json'), JSON.stringify(lastLimits)); } catch { /* non-fatal */ }
  } catch (err) {
    // A transient failure should not blank out bars we already have — keep the
    // last good data and mark it stale.
    if (lastLimits && lastLimits.ok) {
      lastLimits.stale = true;
      lastLimits.staleError = String(err.message || err);
    } else {
      lastLimits = { ok: false, fetchedAt: Date.now(), error: String(err.message || err) };
    }
  }
  pushData();
}

// A refreshed login (any `claude` CLI run) should recover the bars immediately
// rather than waiting out a backoff.
function watchCredentials() {
  const credPath = path.join(CLAUDE_DIR, '.credentials.json');
  setInterval(() => {
    let st;
    try {
      st = fs.statSync(credPath);
    } catch {
      return;
    }
    if (lastCredMtime && st.mtimeMs !== lastCredMtime) {
      limitsBackoffUntil = 0;
      limitsBackoffMin = 0;
      fetchLimits();
    }
    lastCredMtime = st.mtimeMs;
  }, 15 * 1000);
}

// ---- hover detection via cursor polling ----
// CSS :hover is unreliable in click-through (pinned) mode, so the main process
// tracks whether the cursor is inside the window and tells the renderer.
function startHoverPolling() {
  const { screen } = require('electron');
  clearInterval(hoverTimer);
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (inside !== hoverState) {
      hoverState = inside;
      win.webContents.send('hud:hover', inside);
    }
  }, 150);
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
    height: settings.compact ? COMPACT_HEIGHT : (b.height || 520),
    x: b.x,
    y: b.y,
    show: false, // transparent frameless windows race on creation; show explicitly below
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
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.showInactive(); });
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
    if (!win.isVisible()) win.showInactive(); // belt and suspenders for the show race
    win.webContents.send('hud:settings', publicSettings());
    win.webContents.send('hud:pinned', settings.pinned);
    pushData();
  });

  if (settings.pinned) win.setIgnoreMouseEvents(true, { forward: true });
}

function publicSettings() {
  return {
    compact: settings.compact,
    planPrice: settings.planPrice,
    planName: settings.planName,
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
    startHoverPolling();
    // Seed with the last successful limits fetch so a restart during an API
    // backoff still shows bars (marked stale until refreshed).
    try {
      const c = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'limits-cache.json'), 'utf8'));
      if (c && c.ok) { c.stale = true; lastLimits = c; }
    } catch { /* no cache yet */ }
    fetchLimits();
    limitsTimer = setInterval(fetchLimits, 5 * 60 * 1000);
    watchCredentials();
  });
}

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---- IPC ----
ipcMain.handle('usage:get', () => lastData);
ipcMain.handle('hud:getSettings', () => publicSettings());

ipcMain.on('hud:setPinned', (_e, pinned) => setPinned(!!pinned));
ipcMain.on('hud:hide', () => { if (win) win.hide(); rebuildTrayMenu(); });

ipcMain.on('hud:reportHeight', (_e, h) => {
  if (!settings.compact || !win || win.isDestroyed()) return;
  const height = Math.round(h);
  if (!Number.isFinite(height) || height < 100 || height > 500) return;
  const b = win.getBounds();
  if (Math.abs(b.height - height) > 4) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height });
  }
});

ipcMain.on('hud:setCompact', (_e, compact) => {
  settings.compact = !!compact;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    if (settings.compact) {
      settings.fullBounds = b;
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: COMPACT_HEIGHT });
    } else {
      const fb = settings.fullBounds;
      win.setBounds({ x: b.x, y: b.y, width: (fb && fb.width) || 420, height: (fb && fb.height) || 520 });
    }
    win.webContents.send('hud:settings', publicSettings());
  }
  saveSettings();
});

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
