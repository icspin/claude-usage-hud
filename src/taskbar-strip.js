'use strict';

// Taskbar strip: a thin window laid over the empty left end of the PRIMARY
// monitor's taskbar. Windows 11 has no deskband API, so this is an ordinary
// topmost window positioned exactly on the taskbar and re-asserted above it.
//
//   left half  - Claude usage bars + spend; click toggles the HUD above it
//   right half - optional capture-pipeline status (see captureDashboard below);
//                click toggles a dashboard popup (hides when it loses focus)
//
// It hides itself while the foreground window covers the whole primary
// display (fullscreen video, games), the same way the real taskbar does.

const { app, BrowserWindow, screen, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Small rolling log of strip clicks, for diagnosing toggle behaviour.
function slog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'strip.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* non-fatal */ }
}
const { spawn } = require('child_process');

const GAP = 6;

// Optional capture-dashboard panel, configured in settings.json:
//   "captureDashboard": { "url": "http://127.0.0.1:8791",
//                         "startExe": "...pythonw.exe", "startArgs": ["dash.py", "--port", "8791"] }
// The dashboard must serve GET <url>/api/state with { inflight: [...], runners: [...] }.
// If it is refused and startExe is set, the strip starts it (at most every
// 5 minutes; a duplicate instance should fail to bind and exit).
// Without captureDashboard the capture panel is simply not shown.
let lastDashStart = 0;
function startDashboard(cfg) {
  if (!cfg.startExe || Date.now() - lastDashStart < 5 * 60 * 1000) return;
  lastDashStart = Date.now();
  try {
    if (!fs.existsSync(cfg.startExe)) return;
    spawn(cfg.startExe, cfg.startArgs || [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    slog('dashboard offline - started ' + cfg.startExe);
  } catch { /* try again after the cooldown */ }
}

function createTaskbarStrip(o) {
  // o: { getSettings, saveSettings, getHud, showHud, hideHud, rebuildTrayMenu }
  let strip = null;
  let capWin = null;
  let capTimer = null;
  let keepTimer = null;
  let fsProc = null;
  let fullscreen = false;
  let lastUsage = null;
  let lastCap = null;

  const enabled = () => o.getSettings().taskbarStrip !== false;
  const capCfg = () => {
    const c = o.getSettings().captureDashboard;
    return c && c.url ? { ...c, url: String(c.url).replace(/\/+$/, '') } : null;
  };

  function taskbarRect() {
    const d = screen.getPrimaryDisplay();
    const b = d.bounds;
    const w = d.workArea;
    const h = b.y + b.height - (w.y + w.height);
    if (h < 24) return null; // no bottom taskbar (auto-hide, or docked elsewhere)
    return { x: b.x, y: w.y + w.height, width: b.width, height: h };
  }

  function stripBounds() {
    const tb = taskbarRect();
    if (!tb) return null;
    const s = o.getSettings();
    return { x: tb.x + (s.stripOffset ?? 12), y: tb.y, width: s.stripWidth || 720, height: tb.height };
  }

  function send(ch, payload) {
    if (strip && !strip.isDestroyed()) strip.webContents.send(ch, payload);
  }

  function sendOpen() {
    const hud = o.getHud();
    send('strip:open', {
      hud: !!(hud && !hud.isDestroyed() && hud.isVisible()),
      cap: !!(capWin && !capWin.isDestroyed() && capWin.isVisible()),
    });
  }

  function create() {
    const sb = stripBounds();
    if (!sb) return;
    strip = new BrowserWindow({
      ...sb,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false, // clicking it must not steal focus (that would blur the popup)
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'strip-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    strip.setAlwaysOnTop(true, 'screen-saver');
    strip.loadFile(path.join(__dirname, '..', 'renderer', 'strip.html'));
    strip.on('closed', () => { strip = null; });
  }

  function refreshVisibility() {
    const want = enabled() && !fullscreen && !!taskbarRect();
    if (want && !strip) create();
    if (!strip || strip.isDestroyed()) return;
    if (want) {
      const sb = stripBounds();
      const cur = strip.getBounds();
      if (sb && (cur.x !== sb.x || cur.y !== sb.y || cur.width !== sb.width || cur.height !== sb.height)) {
        strip.setBounds(sb);
      }
      if (!strip.isVisible()) strip.showInactive();
      // The taskbar is itself topmost; clicking it raises it over us. Re-assert.
      strip.setAlwaysOnTop(true, 'screen-saver');
      strip.moveTop();
    } else if (strip.isVisible()) {
      strip.hide();
    }
  }

  // ---- capture pipeline ----
  async function pollCapture() {
    const cfg = capCfg();
    if (!cfg) { lastCap = { disabled: true }; send('cap:state', lastCap); return; }
    let s;
    try {
      const r = await fetch(cfg.url + '/api/state', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      const rec = (d.inflight || [])
        .filter((i) => !i.skipped)
        .map((i) => ({
          name: i.handle || i.nick || '?',
          elapsed: Math.max(0, i.elapsed || 0),
          mb: Math.round((i.bytes || 0) / 1e6),
          chat: i.chat || 0,
          finishing: i.phase === 'finishing',
        }));
      // Post-capture work lives on the archive entries: render stage + upload.
      const work = [];
      let queued = 0;
      let held = 0;
      const recentMs = 12 * 3600000;
      for (const a of d.archives || []) {
        const rd = a.render || {};
        const name = a.handle || a.nick || '?';
        const st = rd.stage || '';
        if (st === 'waiting') queued++;
        else if (st === 'held') held++;
        else if (st === 'rendering' || st === 'stage1' || st === 'stage2') {
          work.push({ kind: 'render', name, pct: Number.isFinite(rd.pct) ? rd.pct : null,
            detail: st === 'stage2' ? 'ffmpeg composite' : st === 'stage1' ? 'chat frames' : 'starting' });
        } else if (st === 'failed') {
          const at = rd.log_at ? Date.parse(rd.log_at) : 0;
          if (!at || Date.now() - at < recentMs) work.push({ kind: 'failed', name, detail: String(rd.detail || '').slice(0, 60) });
        }
        if (rd.upload === 'uploading' || a.upload === 'uploading') {
          const pct = Number.isFinite(a.upload_pct) ? a.upload_pct : Number.isFinite(rd.upload_pct) ? rd.upload_pct : null;
          work.push({ kind: 'upload', name, pct });
        }
      }
      const runners = d.runners || [];
      s = { ok: true, rec, work, queued, held,
        alive: runners.filter((r2) => r2.alive).length, total: runners.length };
    } catch (err) {
      const timedOut = err && err.name === 'TimeoutError';
      if (!timedOut) startDashboard(cfg); // refused = not running; a timeout means busy, leave it
      s = { ok: false, error: timedOut ? 'dashboard not answering' : 'dashboard not running - starting it' };
    }
    lastCap = s;
    send('cap:state', s);
  }

  function capPopupBounds(left) {
    const s = o.getSettings();
    const size = s.capPopup || { width: 560, height: 760 };
    const sb = strip ? strip.getBounds() : stripBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    const height = Math.min(size.height, wa.height - GAP * 2);
    let x = sb.x + (left || 0);
    // Don't land on top of the HUD when both are open: sit to its right.
    const hud = o.getHud();
    if (hud && !hud.isDestroyed() && hud.isVisible()) {
      const hb = hud.getBounds();
      x = Math.max(x, hb.x + hb.width + GAP);
    }
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - size.width));
    return { x, y: sb.y - height - GAP, width: size.width, height };
  }

  function createCapWin() {
    capWin = new BrowserWindow({
      width: 560,
      height: 760,
      show: false,
      title: 'Capture pipeline',
      autoHideMenuBar: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      minimizable: false,
      backgroundColor: '#111216',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    capWin.setAlwaysOnTop(true, 'screen-saver');
    capWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    capWin.webContents.on('did-fail-load', (_e, code) => {
      if (code === -3) return; // aborted by a reload
      capWin.loadURL('data:text/html,' + encodeURIComponent(
        '<body style="background:#111216;color:#ccc;font:14px Segoe UI;padding:24px">' +
        'Capture dashboard is not answering.<br>It retries each time you open this.</body>'));
    });
    capWin.on('close', (e) => { e.preventDefault(); capWin.hide(); });
    capWin.on('hide', sendOpen);
    capWin.on('show', sendOpen);
    // Popup behaviour: click anywhere else and it gets out of the way.
    capWin.on('blur', () => { if (capWin && capWin.isVisible()) capWin.hide(); });
    capWin.on('resized', () => {
      const b = capWin.getBounds();
      o.getSettings().capPopup = { width: b.width, height: b.height };
      o.saveSettings();
    });
    capWin.loadURL(capCfg().url + '/');
  }

  function toggleCap(left) {
    if (!capWin || capWin.isDestroyed()) createCapWin();
    if (capWin.isVisible()) { capWin.hide(); return; }
    capWin.setBounds(capPopupBounds(left));
    const url = capWin.webContents.getURL();
    if (!url.startsWith(capCfg().url)) capWin.loadURL(capCfg().url + '/');
    else capWin.webContents.reload();
    capWin.show();
    capWin.focus();
  }

  function toggleHud(left) {
    const hud = o.getHud();
    if (hud && !hud.isDestroyed() && hud.isVisible()) { o.hideHud(); sendOpen(); return; }
    o.showHud((h) => {
      // Anchor the HUD's bottom-left just above the part of the strip clicked.
      // Primary display only, so no mixed-DPI move (see main.js drag notes).
      const sb = strip.getBounds();
      const hb = h.getBounds();
      const wa = screen.getPrimaryDisplay().workArea;
      const x = Math.max(wa.x, Math.min(sb.x + (left || 0), wa.x + wa.width - hb.width));
      h.setPosition(x, sb.y - hb.height - GAP);
    });
    sendOpen();
  }

  // ---- fullscreen detection ----
  // A long-lived PowerShell reports the foreground window's rect every 800 ms.
  // Electron has no API for "is something fullscreen", and this avoids a
  // native module. All ASCII: PS 5.1 misreads non-ASCII in -Command text.
  function startFullscreenWatch() {
    const ps = [
      'Add-Type @"',
      'using System; using System.Runtime.InteropServices; using System.Text;',
      'public class FGW {',
      ' [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      ' [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      ' [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
      ' public struct RECT { public int L, T, R, B; }',
      '}',
      '"@',
      'while ($true) {',
      ' $h = [FGW]::GetForegroundWindow(); $r = New-Object FGW+RECT',
      ' [void][FGW]::GetWindowRect($h, [ref]$r); $sb = New-Object System.Text.StringBuilder 64',
      ' [void][FGW]::GetClassName($h, $sb, 64)',
      ' [Console]::Out.WriteLine(("{0} {1} {2} {3} {4}" -f $r.L, $r.T, $r.R, $r.B, $sb.ToString()))',
      ' Start-Sleep -Milliseconds 800',
      '}',
    ].join('\n');
    // -EncodedCommand, not stdin: PowerShell reads piped stdin line by line,
    // which breaks the multi-line here-string and loop.
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    fsProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true });
    fsProc.on('error', () => { fsProc = null; });
    let buf = '';
    fsProc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = line.match(/^(-?\d+) (-?\d+) (-?\d+) (-?\d+) (.*)$/);
        if (!m) continue;
        const [L, T, R, B] = m.slice(1, 5).map(Number);
        const cls = m[5];
        const d = screen.getPrimaryDisplay();
        const f = d.scaleFactor;
        const b = d.bounds;
        const covers = L <= b.x * f && T <= b.y * f && R >= (b.x + b.width) * f && B >= (b.y + b.height) * f;
        const desktop = /^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$/.test(cls);
        const fs = covers && !desktop;
        if (fs !== fullscreen) { fullscreen = fs; refreshVisibility(); }
      }
    });
    fsProc.on('exit', () => {
      fsProc = null;
      if (fullscreen) { fullscreen = false; refreshVisibility(); }
    });
  }

  // ---- IPC ----
  ipcMain.on('strip:ready', () => {
    if (lastUsage) send('usage:data', lastUsage);
    if (lastCap) send('cap:state', lastCap);
    sendOpen();
  });
  ipcMain.on('strip:click', (_e, kind, left) => {
    const hud = o.getHud();
    slog(`click ${kind} left=${left} hudVisible=${!!(hud && !hud.isDestroyed() && hud.isVisible())} capVisible=${!!(capWin && !capWin.isDestroyed() && capWin.isVisible())}`);
    if (kind === 'hud') toggleHud(left);
    else if (kind === 'cap') toggleCap(left);
  });
  ipcMain.on('strip:menu', () => {
    const cfg = capCfg();
    Menu.buildFromTemplate([
      ...(cfg ? [{ label: 'Open capture dashboard in browser', click: () => shell.openExternal(cfg.url + '/') }, { type: 'separator' }] : []),
      { label: 'Hide taskbar strip', click: () => setEnabled(false) },
    ]).popup();
  });

  function setEnabled(on) {
    o.getSettings().taskbarStrip = !!on;
    o.saveSettings();
    refreshVisibility();
    o.rebuildTrayMenu();
  }

  function start() {
    refreshVisibility();
    pollCapture();
    capTimer = setInterval(pollCapture, 5000);
    keepTimer = setInterval(refreshVisibility, 1500);
    startFullscreenWatch();
    screen.on('display-metrics-changed', refreshVisibility);
    screen.on('display-added', refreshVisibility);
    screen.on('display-removed', refreshVisibility);
  }

  function stop() {
    clearInterval(capTimer);
    clearInterval(keepTimer);
    if (fsProc) { try { fsProc.kill(); } catch { /* gone */ } }
  }

  return {
    start,
    stop,
    setEnabled,
    isEnabled: enabled,
    pushUsage(data) { lastUsage = data; send('usage:data', data); },
    hudVisibilityChanged: sendOpen,
  };
}

module.exports = { createTaskbarStrip };
