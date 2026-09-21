'use strict';

// Throttle alerts: a native notification when a rate-limit window is being
// used faster than it refills, naming the sessions that are burning the most.
// It only ever suggests. Nothing here changes a session's model or effort.
//
// Weekly windows (all models, and each model-scoped cap such as Fable) use
// pace = percent used / percent of the window elapsed, so 1.0 is exactly on
// pace to land at 100% as the window resets. The 5-hour window uses a plain
// high-water mark instead, because pace is meaningless a few minutes into it.

const fs = require('fs');
const { entryCost } = require('./pricing');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const STALE_MS = 15 * 60 * 1000; // official numbers older than this count as stale
const REARM_PACE = 0.1; // a pace level re-arms only once pace drops this far below it
const REARM_PCT = 5; // same for the 5-hour high-water mark, in percentage points
const MIN_PCT = 5; // ignore pace on a window that has barely been touched
const MIN_CALIBRATION_USD = 20; // too little spend to trust a %-per-dollar ratio

const DEFAULT_THROTTLE = {
  enabled: true,
  warnPace: 1.2,
  strongPace: 1.5,
  sessionHighWater: 80,
  minElapsedPct: 10, // no pace alerts in the first 10% of a weekly window
  lookbackHours: 3,
  useEstimates: true,
  sessionManagerUrl: '', // clicking the alert opens this (e.g. a claude:// session link)
  guidance:
    'Fable for design, hard debugging and first builds. Opus for routine operations, relays, research lookups and drafting. Lower effort before lowering model.',
};

// 'claude-fable-5-1' -> 'Fable 5.1', 'claude-haiku-4-5-20251001' -> 'Haiku 4.5'
function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id || '');
  if (!m) return id || '?';
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '');
}

// Limits cached by an older HUD lack kind/scopeModel; derive them from the label.
function normalize(w) {
  if (w.kind && w.scopeModel !== undefined) return w;
  const m = /^Week \((.+)\)$/.exec(w.label || '');
  return {
    ...w,
    kind: w.kind || (/session|five_hour/.test(w.key || '') ? 'session' : 'weekly'),
    scopeModel: w.scopeModel !== undefined ? w.scopeModel : m && m[1] !== 'all models' ? m[1] : null,
  };
}

function windowLength(w) {
  return w.kind === 'session' ? 5 * HOUR : 7 * DAY;
}

// Which transcript entries count against this window.
function scopeFilter(w) {
  if (!w.scopeModel) return () => true;
  const needle = w.scopeModel.toLowerCase();
  return (e) => e.model.toLowerCase().includes(needle);
}

function fmtTime(ts, now) {
  ts = Math.round(ts / 60000) * 60000; // resets land at :59:59
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ts - now < 20 * HOUR && d.getDate() === new Date(now).getDate()) return t;
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
}

function money(v) {
  return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
}

function createThrottle({ getSettings, statePath, logPath, notify }) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch { /* first run */ }

  const cfg = () => ({ ...DEFAULT_THROTTLE, ...(getSettings().throttle || {}) });

  function save() {
    try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch { /* non-fatal */ }
  }

  function log(line) {
    try { fs.appendFileSync(logPath, new Date().toISOString() + ' ' + line + '\n'); } catch { /* non-fatal */ }
  }

  // Current reading for one window: official when fresh, otherwise (weekly
  // only) the last official figure plus transcript spend since, converted at
  // the %-per-dollar ratio this same window had at that fetch.
  function reading(w, limits, entries, pricing, now, c) {
    if (!w.resetsAt || w.resetsAt <= now) return null;
    const len = windowLength(w);
    const start = w.resetsAt - len;
    const elapsed = Math.max(0, Math.min(1, (now - start) / len));
    const stale = limits.stale || now - limits.fetchedAt > STALE_MS;
    let pct = w.pct;
    let estimated = false;
    if (stale) {
      if (w.kind === 'session' || !c.useEstimates || limits.fetchedAt < start) return null;
      const inScope = scopeFilter(w);
      let before = 0, since = 0;
      for (const e of entries) {
        if (e.ts < start || !inScope(e)) continue;
        const cost = entryCost(pricing, e.model, e);
        if (e.ts < limits.fetchedAt) before += cost; else since += cost;
      }
      if (before < MIN_CALIBRATION_USD || w.pct <= 0) return null;
      pct = Math.min(100, w.pct + since * (w.pct / before));
      estimated = true;
    }
    const pace = elapsed > 0 ? pct / (elapsed * 100) : 0;
    return { pct, elapsed, pace, estimated, start };
  }

  function levelsFor(w, r, c) {
    if (w.kind === 'session') {
      return [{ id: 'high', crossed: r.pct >= c.sessionHighWater, rearm: r.pct < c.sessionHighWater - REARM_PCT, strong: true }];
    }
    const eligible = r.elapsed * 100 >= c.minElapsedPct && r.pct >= MIN_PCT;
    return [
      { id: 'warn', crossed: eligible && r.pace >= c.warnPace, rearm: r.pace < c.warnPace - REARM_PACE, strong: false },
      { id: 'strong', crossed: eligible && r.pace >= c.strongPace, rearm: r.pace < c.strongPace - REARM_PACE, strong: true },
    ];
  }

  function topSessions(w, r, entries, pricing, meta, titles, now, c) {
    const since = Math.max(r.start, now - c.lookbackHours * HOUR);
    const inScope = scopeFilter(w);
    const by = new Map();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.ts < since) break; // entries are sorted ascending
      if (!inScope(e)) continue;
      let s = by.get(e.sessionId);
      if (!s) { s = { id: e.sessionId, projectDir: e.projectDir, cost: 0, models: {} }; by.set(e.sessionId, s); }
      const cost = entryCost(pricing, e.model, e);
      s.cost += cost;
      s.models[e.model] = (s.models[e.model] || 0) + cost;
    }
    return [...by.values()]
      .filter((s) => s.cost >= 0.5)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 3)
      .map((s) => {
        const m = meta.get(s.id);
        const title = (m && m.name) || titles.get(s.id) || null;
        const where = m && m.cwd ? m.cwd.split(/[\\/]/).filter(Boolean).pop() : s.projectDir;
        const model = Object.entries(s.models).sort((a, b) => b[1] - a[1])[0][0];
        return {
          id: s.id,
          title,
          // No recorded title: say where it runs and its id rather than invent a name.
          label: title ? `${title} (${where})` : `untitled session in ${s.projectDir}, id ${s.id.slice(0, 8)}`,
          model: modelName(model),
          cost: s.cost,
        };
      });
  }

  // Windows shows the title plus about four body lines in the banner (the rest
  // is in Action Center), so the title carries what and when, and the body
  // leads with who is burning it.
  function buildAlert(w, r, level, top, now, c, test) {
    const est = r.estimated ? ' (est.)' : '';
    let title;
    const lines = [];
    if (w.kind === 'session') {
      title = `${w.label} at ${Math.round(r.pct)}%${est}, resets ${fmtTime(w.resetsAt, now)}`;
    } else {
      title = `${w.label} at ${r.pace.toFixed(2)}x pace${est}`;
      const runsOut = r.pace > 1 ? r.start + windowLength(w) / r.pace : Infinity;
      if (runsOut < w.resetsAt) title += `, runs out ${fmtTime(runsOut, now)}`;
    }
    if (test) title = 'Test: ' + title;
    const scope = w.scopeModel ? `Top ${w.scopeModel} spend` : 'Top spend';
    const hrs = w.kind === 'session' ? 'this window' : `last ${c.lookbackHours}h`;
    if (top.length) {
      lines.push(`${scope}, ${hrs}:`);
      for (const s of top) lines.push(`• ${s.label}, ${s.model}, ${money(s.cost)}`);
    } else {
      lines.push(`No session spent more than $0.50 on it in the ${hrs}.`);
    }
    lines.push(
      w.kind === 'session'
        ? `${Math.round(r.pct)}% used.`
        : `${Math.round(r.pct)}% used with ${Math.round(r.elapsed * 100)}% of the week gone. Resets ${fmtTime(w.resetsAt, now)}.`
    );
    if (c.guidance) lines.push(c.guidance);
    if (c.sessionManagerUrl) lines.push('Click to open the Session Manager.');
    return {
      title,
      body: lines.join('\n'),
      strong: level.strong,
      url: c.sessionManagerUrl || null,
      windowKey: w.key,
      level: level.id,
      sessions: top,
    };
  }

  // Called after every scan and limits fetch. Fires at most one alert per
  // window per level, persisted so a HUD restart does not re-fire.
  function evaluate({ limits, entries, meta, titles, pricing, now = Date.now() }) {
    const c = cfg();
    if (!c.enabled || !limits || !limits.ok || !Array.isArray(limits.windows) || !entries) return [];
    const fired = [];
    let dirty = false;
    for (const w0 of limits.windows) {
      const w = normalize(w0);
      const r = reading(w, limits, entries, pricing, now, c);
      if (!r) continue;
      let st = state[w.key];
      // A new window (reset times jitter by a second, so compare loosely).
      if (!st || Math.abs((st.resetsAt || 0) - w.resetsAt) > HOUR) {
        st = state[w.key] = { resetsAt: w.resetsAt, fired: {} };
        dirty = true;
      }
      const levels = levelsFor(w, r, c);
      for (const l of levels) {
        if (st.fired[l.id] && l.rearm) { delete st.fired[l.id]; dirty = true; log(`rearm ${w.key} ${l.id}`); }
      }
      const crossed = levels.filter((l) => l.crossed);
      if (!crossed.length) continue;
      const top = crossed[crossed.length - 1]; // highest level crossed
      const isNew = !st.fired[top.id];
      for (const l of crossed) if (!st.fired[l.id]) { st.fired[l.id] = now; dirty = true; }
      if (!isNew) continue;
      const alert = buildAlert(w, r, top, topSessions(w, r, entries, pricing, meta, titles, now, c), now, c, false);
      log(`fire ${w.key} ${top.id} pct=${r.pct.toFixed(1)} pace=${r.pace.toFixed(2)} est=${r.estimated}`);
      notify(alert);
      fired.push(alert);
    }
    if (dirty) save();
    return fired;
  }

  // Settings "Send test alert": the window closest to tripping, regardless of
  // levels or what already fired. Does not touch the fired state.
  function testAlert({ limits, entries, meta, titles, pricing, now = Date.now() }) {
    const c = cfg();
    if (!limits || !limits.ok || !Array.isArray(limits.windows)) {
      return { error: 'No limit data yet' + (limits && limits.error ? ` (${limits.error})` : '') };
    }
    let best = null;
    for (const w0 of limits.windows) {
      const w = normalize(w0);
      const r = reading(w, limits, entries || [], pricing, now, { ...c, useEstimates: true });
      if (!r) continue;
      const score = w.kind === 'session' ? r.pct / c.sessionHighWater : r.pace / c.warnPace;
      if (!best || score > best.score) best = { w, r, score };
    }
    if (!best) return { error: 'No window has a usable reading' };
    const level = levelsFor(best.w, best.r, c).pop();
    const alert = buildAlert(best.w, best.r, level, topSessions(best.w, best.r, entries || [], pricing, meta, titles, now, c), now, c, true);
    log(`test ${best.w.key} pct=${best.r.pct.toFixed(1)} pace=${best.r.pace.toFixed(2)} est=${best.r.estimated}`);
    notify(alert);
    return { ok: true, title: alert.title };
  }

  return { evaluate, testAlert };
}

module.exports = { createThrottle, DEFAULT_THROTTLE, modelName };
