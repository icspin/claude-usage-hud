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
  autoRefreshToken: true,
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
let topmostTimer = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let s;
  try {
    s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    s = { ...DEFAULT_SETTINGS };
  }
  // Pinning is a transient mode, not a preference: always start interactive so
  // the window can never come back click-through and unreachable.
  s.pinned = false;
  s.bounds = sanitizeBounds(s.bounds);
  s.fullBounds = s.fullBounds ? sanitizeBounds(s.fullBounds) : null;
  return s;
}

const MIN_W = 280, MAX_W = 900, MIN_H = 120, MAX_H = 900;
const unsafeDisplays = new Set();

// A size that got corrupted (see the drag/DPI notes below) must not persist
// across restarts, so clamp whatever we read back from disk.
function sanitizeBounds(b) {
  if (!b || typeof b !== 'object') return { width: 470, height: 240 };
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    ...b,
    width: Math.max(MIN_W, Math.min(MAX_W, Math.round(num(b.width, 470)))),
    height: Math.max(MIN_H, Math.min(MAX_H, Math.round(num(b.height, 240)))),
  };
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
    const cred = JSON.parse(raw).claudeAiOauth || {};

    // Claude Code blanks these fields when its own OAuth session ends. That is
    // a full sign-out, not an expiry a refresh can fix, so say so instead of
    // reporting a vague missing-login and quietly retrying forever.
    if (!cred.accessToken) throw new Error('signed out');

    // Renew a little before expiry so the bars never actually go stale.
    if (cred.expiresAt && Date.now() >= cred.expiresAt - 10 * 60 * 1000) {
      const refreshing = refreshTokenViaCli();
      // Don't spend a request on a token we can already see is expired — it
      // can't succeed, and failed calls still count against the rate limit.
      if (Date.now() >= cred.expiresAt) {
        throw new Error(refreshing ? 'token expired — refreshing' : 'token expired');
      }
    }
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

// Refreshing the OAuth token by invoking the Claude CLI, rather than using the
// refresh token directly: the CLI owns credential rotation, so this can't race
// with Claude Code or invalidate its login. Costs one trivial Haiku call.
let lastRefreshAttempt = 0;
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

function findClaudeCli() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* try next */ }
  }
  return null; // fall back to PATH lookup by the shell
}

function refreshTokenViaCli() {
  if (!settings.autoRefreshToken) return false;
  if (Date.now() - lastRefreshAttempt < REFRESH_COOLDOWN_MS) return false;
  lastRefreshAttempt = Date.now();

  const cli = findClaudeCli();
  if (!cli) return false;

  const { execFile } = require('child_process');
  const child = execFile(
    cli,
    ['-p', 'ok', '--model', 'claude-haiku-4-5'],
    { timeout: 90 * 1000, windowsHide: true, cwd: os.homedir() },
    (err) => {
      if (!err) {
        // The credentials watcher will notice the rewritten file, but clear the
        // backoff here so recovery isn't delayed by an in-flight 429 window.
        limitsBackoffUntil = 0;
        limitsBackoffMin = 0;
        setTimeout(fetchLimits, 1500);
      }
    }
  );
  child.unref();
  return true;
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

// ---- global middle-click to unpin ----
// A pinned window is click-through, so it never sees the click itself. Rather
// than pull in a native global-hook module, a tiny PowerShell helper polls the
// middle button and reports click coordinates on stdout. It only runs while
// pinned, and is killed the moment the window becomes interactive again.
const MIDDLE_CLICK_WATCHER = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MK {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct POINT { public int X; public int Y; }
}
"@
$was = $false
while ($true) {
  $down = ([MK]::GetAsyncKeyState(4) -band 0x8000) -ne 0
  if ($down -and -not $was) {
    $p = New-Object MK+POINT
    [MK]::GetCursorPos([ref]$p) | Out-Null
    Write-Output "$($p.X) $($p.Y)"
    [Console]::Out.Flush()
  }
  $was = $down
  Start-Sleep -Milliseconds 40
}
`;

let mouseWatcher = null;

function startMiddleClickWatch() {
  if (mouseWatcher || process.platform !== 'win32') return;
  let scriptPath;
  try {
    scriptPath = path.join(app.getPath('userData'), 'middle-click-watch.ps1');
    fs.writeFileSync(scriptPath, MIDDLE_CLICK_WATCHER);
  } catch {
    return; // no watcher; Ctrl+Alt+U and the tray still unpin
  }

  const { spawn } = require('child_process');
  mouseWatcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );

  let buf = '';
  mouseWatcher.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = line.trim().match(/^(-?\d+)\s+(-?\d+)$/);
      if (m) onGlobalMiddleClick(Number(m[1]), Number(m[2]));
    }
  });
  mouseWatcher.on('exit', () => { mouseWatcher = null; });
  mouseWatcher.on('error', () => { mouseWatcher = null; });
}

function stopMiddleClickWatch() {
  if (!mouseWatcher) return;
  try { mouseWatcher.kill(); } catch { /* already gone */ }
  mouseWatcher = null;
}

function onGlobalMiddleClick(physX, physY) {
  if (!settings.pinned || !win || win.isDestroyed() || !win.isVisible()) return;
  const { screen } = require('electron');
  // The helper reports physical pixels; window bounds are in DIP. Converting
  // matters on mixed-DPI setups, where the two spaces disagree.
  let pt = { x: physX, y: physY };
  try {
    pt = screen.screenToDipPoint(pt);
  } catch { /* fall back to raw coordinates */ }
  const b = win.getBounds();
  if (pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height) {
    setPinned(false);
  }
}

// Windows quietly drops a window's topmost style in several situations — an
// app going fullscreen, another process forcing itself foreground, a display
// change. Electron still reports alwaysOnTop as true, so the flag can't be
// trusted; re-assert it instead. `force` toggles it off and back on, which
// makes Windows re-apply the style rather than treating it as a no-op.
function reassertTopmost(force = false) {
  if (!win || win.isDestroyed() || !settings.alwaysOnTop) return;
  if (!win.isVisible() || win.isMinimized()) return;
  if (force) win.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, 'screen-saver');
}

function startTopmostKeeper() {
  clearInterval(topmostTimer);
  topmostTimer = setInterval(() => reassertTopmost(false), 2000);

  const { screen } = require('electron');
  screen.on('display-metrics-changed', () => reassertTopmost(true));
  screen.on('display-added', () => reassertTopmost(true));
  screen.on('display-removed', () => reassertTopmost(true));
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
      applyOpacity();
    }
  }, 150);
}

// Translucency lives at the window level now that the window is opaque to the
// compositor. Pinned stays faded even under the cursor — you are meant to see
// (and click) what is behind it.
function applyOpacity() {
  if (!win || win.isDestroyed()) return;
  const idle = Math.max(0.15, Math.min(1, settings.idleOpacity ?? 0.55));
  win.setOpacity(!settings.pinned && hoverState ? 1 : idle);
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
  applyOpacity();
  if (pinned) startMiddleClickWatch(); else stopMiddleClickWatch();
  rebuildTrayMenu();
}

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 420,
    height: settings.compact ? COMPACT_HEIGHT : (b.height || 520),
    x: b.x,
    y: b.y,
    show: false, // frameless windows race on creation; show explicitly below
    frame: false,
    // NOT transparent: Windows refuses to resize a transparent frameless
    // window, so the frame was completely un-resizable. The see-through look
    // comes from window-level opacity instead (see applyOpacity), which keeps
    // the window a normal, resizable one.
    transparent: false,
    backgroundColor: '#0f1016',
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    minWidth: 280,
    minHeight: 160,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  ensureOnScreen();
  applyOpacity();
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.showInactive(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('resize', sendWinSize);
  // Moments Windows is most likely to have demoted the window.
  win.on('show', () => reassertTopmost(true));
  win.on('restore', () => reassertTopmost(true));
  win.on('blur', () => reassertTopmost(false));
  win.on('closed', () => { win = null; });

  win.webContents.on('did-finish-load', () => {
    if (!win.isVisible()) win.showInactive(); // belt and suspenders for the show race
    sendWinSize();
    win.webContents.send('hud:settings', publicSettings());
    win.webContents.send('hud:pinned', settings.pinned);
    pushData();
  });

  if (settings.pinned) win.setIgnoreMouseEvents(true, { forward: true });
}

// A monitor can be unplugged, or saved coordinates can land in a gap between
// displays. Either way the window would be invisible with no way to reach it,
// so drop it back onto the primary display.
function ensureOnScreen() {
  if (!win || win.isDestroyed()) return;
  const { screen } = require('electron');
  const b = win.getBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      b.x < a.x + a.width && b.x + b.width > a.x &&
      b.y < a.y + a.height && b.y + b.height > a.y
    );
  });
  // Also rescue a window that is technically on-screen but too small to read.
  // Mixed-DPI displays can leave it a fraction of its intended size.
  const tooSmall = b.width < 300 || b.height < 190;
  if (visible && !tooSmall) return;

  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.max(300, Math.min(MAX_W, b.width));
  const height = Math.max(190, Math.min(MAX_H, b.height));
  win.setBounds({
    x: visible ? b.x : wa.x + wa.width - width - 40,
    y: visible ? b.y : wa.y + 40,
    width,
    height,
  });
  settings.bounds = win.getBounds();
  saveSettings();
}

// The renderer scales the compact panel to the window width; it gets that
// width from here rather than measuring a viewport it is actively zooming.
function sendWinSize() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('hud:winsize', win.getContentBounds().width);
}

function publicSettings() {
  return {
    compact: settings.compact,
    planPrice: settings.planPrice,
    planName: settings.planName,
    autoRefreshToken: settings.autoRefreshToken,
    claudeCliFound: !!findClaudeCli(),
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
    {
      label: 'Reset size & position',
      click: () => {
        if (!win || win.isDestroyed()) return;
        const { screen } = require('electron');
        const wa = screen.getPrimaryDisplay().workArea;
        const width = 470;
        const height = settings.compact ? COMPACT_HEIGHT : 520;
        win.setBounds({ x: wa.x + wa.width - width - 40, y: wa.y + 40, width, height });
        settings.bounds = win.getBounds();
        settings.fullBounds = null;
        saveSettings();
        win.show();
      },
    },
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
    startTopmostKeeper();
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
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopMiddleClickWatch();
});

// ---- IPC ----
ipcMain.handle('usage:get', () => lastData);
ipcMain.handle('hud:getSettings', () => publicSettings());

ipcMain.on('hud:setPinned', (_e, pinned) => setPinned(!!pinned));
ipcMain.on('hud:hide', () => { if (win) win.hide(); rebuildTrayMenu(); });

ipcMain.on('hud:reportHeight', (_e, h) => {
  if (!settings.compact || !win || win.isDestroyed() || win.isMinimized()) return;
  const height = Math.round(h);
  if (!Number.isFinite(height) || height < MIN_H || height > MAX_H) return;

  const b = win.getBounds();
  if (Math.abs(b.height - height) <= 4) return;

  const { screen } = require('electron');
  const dispId = screen.getDisplayMatching(b).id;
  // Height-only resizes are normally safe. On some mixed-DPI setups Chromium
  // applies the new bounds in the wrong coordinate space and the width shifts
  // as a side effect — which is how the frame used to creep. Detect that once
  // per display, undo it, and stop auto-fitting there rather than compounding.
  if (unsafeDisplays.has(dispId)) return;

  win.setBounds({ x: b.x, y: b.y, width: b.width, height });

  const after = win.getBounds();
  if (after.width !== b.width) {
    unsafeDisplays.add(dispId);
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: after.height });
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
  if (patch.idleOpacity !== undefined) applyOpacity();
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

// Window moving is native (-webkit-app-region: drag). Nothing is scripted here
// on purpose: setBounds/setPosition on a window sitting on a display whose
// scale factor differs from the primary's rescales the frame, which is what
// made the window creep larger every time it was dragged across monitors.
