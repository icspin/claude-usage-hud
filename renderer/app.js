'use strict';

let data = null;
let settings = null;
let activeTab = 'overview';

const $ = (sel) => document.querySelector(sel);
const content = $('#content');

// ---------- formatting ----------
function money(v) {
  if (v == null) return '—';
  if (v >= 100) return '$' + v.toFixed(0);
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
}
function tokens(v) {
  if (v == null) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}
function shortModel(id) {
  return String(id)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function hm(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- shared pieces ----------
function barRows(byModel, totalCost) {
  const rows = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="muted">no usage</div>';
  return rows.map(([m, c]) => {
    const pct = totalCost > 0 ? (c / totalCost) * 100 : 0;
    return `<div class="bar-row">
      <span class="name" title="${esc(m)}">${esc(shortModel(m))}</span>
      <span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      <span class="val">${money(c)}</span>
    </div>`;
  }).join('');
}

function tokenCells(b) {
  return `<td class="num">${tokens(b.input)}</td>
    <td class="num">${tokens(b.output)}</td>
    <td class="num">${tokens(b.cacheRead)}</td>
    <td class="num">${tokens((b.w5m ?? 0) + (b.w1h ?? 0) + (b.cacheWrite ?? 0))}</td>`;
}

// ---------- tabs ----------
function renderOverview() {
  const t = data.totals;
  const cb = data.currentBlock;
  const blockHtml = cb
    ? `<div class="card">
        <h3>Current 5-hour block · ${hm(cb.start)}–${hm(cb.end)} · ${dur(cb.remainingMs)} left</h3>
        <div class="stat-grid">
          <div class="stat"><div class="label">Block cost</div><div class="value">${money(cb.cost)}</div></div>
          <div class="stat"><div class="label">Output tok</div><div class="value">${tokens(cb.output)}</div></div>
          <div class="stat"><div class="label">Messages</div><div class="value">${cb.messages}</div></div>
        </div>
        ${barRows(cb.byModel, cb.cost)}
      </div>`
    : '<div class="card"><h3>Current 5-hour block</h3><div class="muted">no active block</div></div>';

  const act = data.activeSessions.length
    ? data.activeSessions.map((s) => {
        const ctx = s.context
          ? `<div class="progress" title="context: ${tokens(s.context.used)} / ${tokens(s.context.max)}"><i style="width:${s.context.pct.toFixed(1)}%"></i></div>
             <div class="note">context ${s.context.pct.toFixed(1)}% (${tokens(s.context.used)} / ${tokens(s.context.max)})</div>`
          : '';
        return `<div class="card">
          <h3><span class="dot live"></span>${esc(s.title || s.projectDir)} <span class="muted">· ${timeAgo(s.lastTs)}</span></h3>
          <div class="stat-grid">
            <div class="stat"><div class="label">Session cost</div><div class="value">${money(s.cost)}</div></div>
            <div class="stat"><div class="label">Output</div><div class="value">${tokens(s.output)}</div></div>
            <div class="stat"><div class="label">Msgs</div><div class="value">${s.messages}</div></div>
          </div>
          ${ctx}
        </div>`;
      }).join('')
    : '<div class="card"><h3>Active sessions</h3><div class="muted">none in the last 5 minutes</div></div>';

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat big"><div class="label">Today</div><div class="value">${money(t.today.cost)}</div><div class="sub">${tokens(t.today.output)} out</div></div>
      <div class="stat"><div class="label">7 days</div><div class="value">${money(t.week.cost)}</div></div>
      <div class="stat"><div class="label">This month</div><div class="value">${money(t.month.cost)}</div></div>
      <div class="stat"><div class="label">All time</div><div class="value">${money(t.allTime.cost)}</div></div>
    </div>
    ${blockHtml}
    ${act}
    <div class="card"><h3>Today by model</h3>${barRows(data.todayByModel, t.today.cost)}</div>
    ${valueCard()}`;
}

function valueCard() {
  if (!settings || !settings.planPrice || settings.planPrice <= 0) return '';
  const m = data.totals.month.cost;
  const days = new Date().getDate();
  const projected = (m / days) * 30.4;
  const rows = [
    { name: 'Pro ($20)', price: 20 },
    { name: 'Max 5x ($100)', price: 100 },
    { name: 'Max 20x ($200)', price: 200 },
  ].map((p) => {
    const mult = m / p.price;
    return `<div class="bar-row">
      <span class="name">${esc(p.name)}</span>
      <span class="bar"><i style="width:${Math.min(100, mult * 10).toFixed(1)}%"></i></span>
      <span class="val">${mult.toFixed(1)}×</span>
    </div>`;
  }).join('');
  return `<div class="card"><h3>Plan value · ${money(m)} API-equivalent this month (projected ${money(projected)})</h3>
    ${rows}
    <div class="note">× = API-equivalent usage ÷ plan price. Your ${esc(settings.planName)} at $${settings.planPrice}/mo has delivered <b>${money(Math.max(0, m - settings.planPrice))}</b> more value than it costs this month. Note: cheaper plans have lower rate limits — this shows value, not whether the usage would fit those plans.</div>
  </div>`;
}

function renderSessions() {
  const rows = data.sessions.slice(0, 60).map((s) => `
    <tr title="${esc(s.cwd || s.projectDir)}\ntokens in ${tokens(s.input)} · cache read ${tokens(s.cacheRead)} · cache write ${tokens(s.cacheWrite)}\n${esc(s.id)}">
      <td><span class="dot ${s.active ? 'live' : ''}"></span><span class="session-title">${esc(s.title || s.projectDir)}</span></td>
      <td class="num cost">${money(s.cost)}</td>
      <td class="muted nowrap">${timeAgo(s.lastTs)}</td>
      <td class="num">${dur(s.lastTs - s.firstTs)}</td>
      <td class="num">${tokens(s.output)}</td>
      <td class="num">${s.messages}</td>
    </tr>`).join('');
  content.innerHTML = `<table>
    <thead><tr><th>Session</th><th class="num">Cost</th><th>Last</th><th class="num">Len</th><th class="num">Out</th><th class="num">Msgs</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">Hover a row for the full token breakdown and session id.</div>`;
}

function renderModels() {
  const total = data.totals.allTime.cost;
  const rows = Object.entries(data.perModel).sort((a, b) => b[1].cost - a[1].cost).map(([m, b]) => `
    <tr title="${esc(m)}">
      <td>${esc(shortModel(m))}</td>
      ${tokenCells(b)}
      <td class="num">${b.messages}</td>
      <td class="num cost">${money(b.cost)}</td>
      <td class="num muted">${total > 0 ? ((b.cost / total) * 100).toFixed(1) : 0}%</td>
    </tr>`).join('');
  content.innerHTML = `
    <div class="card"><h3>All-time cost share</h3>${barRows(Object.fromEntries(Object.entries(data.perModel).map(([m, b]) => [m, b.cost])), total)}</div>
    <table>
      <thead><tr><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">C·read</th><th class="num">C·write</th><th class="num">Msgs</th><th class="num">Cost</th><th class="num">%</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="note">Cache reads are billed at 0.1× the input rate; cache writes at 1.25× (5m TTL) or 2× (1h TTL). Costs are API-equivalent — on a Pro/Max subscription this is the value consumed, not an actual bill.</div>`;
}

function renderDaily() {
  const days = data.daily.slice(0, 30);
  const max = Math.max(...days.map((d) => d.cost), 0.0001);
  const chart = days.slice().reverse().map((d) => `
    <div class="bar-row" title="${d.date}: ${money(d.cost)}">
      <span class="name">${d.date.slice(5)}</span>
      <span class="bar"><i style="width:${((d.cost / max) * 100).toFixed(1)}%"></i></span>
      <span class="val">${money(d.cost)}</span>
    </div>`).join('');
  const rows = days.map((d) => `
    <tr><td>${d.date}</td>${tokenCells(d)}<td class="num">${d.messages}</td><td class="num cost">${money(d.cost)}</td></tr>`).join('');
  content.innerHTML = `
    <div class="card"><h3>Last 30 days</h3>${chart}</div>
    <table>
      <thead><tr><th>Date</th><th class="num">In</th><th class="num">Out</th><th class="num">C·read</th><th class="num">C·write</th><th class="num">Msgs</th><th class="num">Cost</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

function renderBlocks() {
  const rows = data.blocks.map((b) => {
    const isCurrent = data.currentBlock && data.currentBlock.start === b.start;
    return `<tr>
      <td>${isCurrent ? '<span class="dot live"></span>' : ''}${new Date(b.start).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm(b.start)}–${hm(b.end)}</td>
      ${tokenCells(b)}
      <td class="num">${b.messages}</td>
      <td class="num cost">${money(b.cost)}</td>
    </tr>`;
  }).join('');
  content.innerHTML = `
    <div class="note" style="margin-bottom:8px">Usage grouped into 5-hour windows — the same window size Claude's subscription rate limits use. A window opens at the top of the hour of your first message after the previous window ends.</div>
    <table>
      <thead><tr><th>Window</th><th class="num">In</th><th class="num">Out</th><th class="num">C·read</th><th class="num">C·write</th><th class="num">Msgs</th><th class="num">Cost</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

function renderSettings() {
  const s = settings || {};
  content.innerHTML = `
    <div class="card"><h3>Behavior</h3>
      <div class="setting-row"><label>Idle opacity</label>
        <span><input id="set-opacity" type="range" min="0.15" max="1" step="0.05" value="${s.idleOpacity ?? 0.55}" />
        <span id="opacity-val" class="muted">${Math.round((s.idleOpacity ?? 0.55) * 100)}%</span></span></div>
      <div class="setting-row"><label>Refresh interval (sec)</label>
        <input id="set-poll" type="number" min="2" max="120" value="${Math.round((s.pollIntervalMs ?? 5000) / 1000)}" /></div>
      <div class="setting-row"><label>Always on top</label>
        <input id="set-ontop" type="checkbox" ${s.alwaysOnTop ? 'checked' : ''} /></div>
      <div class="setting-row"><label>Launch at login</label>
        <input id="set-login" type="checkbox" ${s.launchAtLogin ? 'checked' : ''} /></div>
      <div class="setting-row"><label>Plan name</label>
        <input id="set-planname" type="text" style="width:110px;background:rgba(255,255,255,0.07);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:3px 6px;" value="${esc(s.planName || '')}" /></div>
      <div class="setting-row"><label>Plan price $/mo (0 = hide savings)</label>
        <input id="set-planprice" type="number" min="0" max="2000" value="${s.planPrice ?? 200}" /></div>
    </div>
    <div class="card"><h3>Pricing (USD per 1M tokens)${s.pricingIsCustom ? ' · custom' : ' · defaults'}</h3>
      <textarea id="set-pricing" class="pricing" spellcheck="false">${esc(JSON.stringify(s.pricing, null, 2))}</textarea>
      <div style="margin-top:6px; display:flex; gap:6px;">
        <button id="btn-save-pricing" class="btn primary">Save pricing</button>
        <button id="btn-reset-pricing" class="btn">Reset to defaults</button>
      </div>
      <div class="note">First matching substring wins. <code>in</code>/<code>out</code> are $/MTok; cache multipliers apply to the input rate. Sonnet 5 has intro pricing ($2/$10) through 2026-08-31 — edit here if you want that reflected.</div>
    </div>
    <div class="card"><h3>Data source</h3>
      <div class="note">Reading transcripts from <code>${esc(s.claudeDir || '')}</code>. Nothing leaves your machine.</div>
    </div>`;

  $('#set-opacity').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    $('#opacity-val').textContent = Math.round(v * 100) + '%';
    document.documentElement.style.setProperty('--idle-opacity', v);
    window.hud.updateSettings({ idleOpacity: v });
  });
  $('#set-poll').addEventListener('change', (e) => {
    const v = Math.max(2, Math.min(120, parseInt(e.target.value, 10) || 5));
    window.hud.updateSettings({ pollIntervalMs: v * 1000 });
  });
  $('#set-ontop').addEventListener('change', (e) => window.hud.updateSettings({ alwaysOnTop: e.target.checked }));
  $('#set-login').addEventListener('change', (e) => window.hud.updateSettings({ launchAtLogin: e.target.checked }));
  $('#set-planname').addEventListener('change', (e) => window.hud.updateSettings({ planName: e.target.value || 'Plan' }));
  $('#set-planprice').addEventListener('change', (e) => window.hud.updateSettings({ planPrice: Math.max(0, parseInt(e.target.value, 10) || 0) }));
  $('#btn-save-pricing').addEventListener('click', () => {
    try {
      const p = JSON.parse($('#set-pricing').value);
      window.hud.updateSettings({ pricing: p });
    } catch (err) {
      alert('Invalid JSON: ' + err.message);
    }
  });
  $('#btn-reset-pricing').addEventListener('click', () => window.hud.updateSettings({ pricing: null }));
}

function untilReset(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm(ts);
  }
  return `${h}h ${m}m left`;
}

function cbar(name, pct, val, sub, cls, tip) {
  if (cls === undefined) cls = pct >= 80 ? 'hot' : pct >= 60 ? 'warn' : '';
  return `<div class="cbar-row" title="${esc(tip || '')}">
    <span class="cname">${esc(name)}</span>
    <span class="cbar"><i class="${cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></i></span>
    <span class="cval ${cls}">${esc(val)}</span>
    <span class="csub">${esc(sub || '')}</span>
  </div>`;
}

// Pace projection: given % used and the reset time, are you on track to hit
// 100% before the window resets?
function paceInfo(w) {
  const windowMs = w.key && w.key.startsWith('session') ? 5 * 3600000 : 7 * 24 * 3600000;
  const now = Date.now();
  const start = w.resetsAt ? w.resetsAt - windowMs : null;
  const out = { cls: '', sub: untilReset(w.resetsAt), tip: '' };

  if (w.severity && w.severity !== 'normal') { out.cls = 'hot'; return out; }
  if (w.pct >= 90) { out.cls = 'hot'; out.tip = 'nearly exhausted'; return out; }

  if (start && now > start && w.pct >= 3) {
    const elapsed = now - start;
    // Ignore the first 10% of a window — projections from a few early
    // minutes of heavy use are meaningless.
    if (elapsed >= windowMs * 0.1) {
      const rate = w.pct / elapsed; // % per ms
      const exhaustAt = now + (100 - w.pct) / rate;
      const projectedEnd = w.pct + rate * (w.resetsAt - now);
      if (exhaustAt < w.resetsAt) {
        out.cls = 'hot';
        out.sub = '⚠ out ' + hm(exhaustAt);
        out.tip = `At the current pace you hit 100% around ${new Date(exhaustAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, before the ${untilReset(w.resetsAt)} reset.`;
        return out;
      }
      if (projectedEnd >= 80) {
        out.cls = 'warn';
        out.tip = `On pace to end the window around ${projectedEnd.toFixed(0)}% — tight but OK.`;
        return out;
      }
      out.tip = `On pace to end the window around ${projectedEnd.toFixed(0)}%.`;
    }
  }
  if (w.pct >= 80) out.cls = 'hot';
  else if (w.pct >= 60) out.cls = 'warn';
  return out;
}

function renderCompact() {
  const t = data.totals;
  const rows = [];
  const lim = data.limits;

  if (lim && lim.ok && lim.windows.length) {
    for (const w of lim.windows) {
      if (w.key === 'seven_day_sonnet' && w.pct === 0) continue;
      const p = paceInfo(w);
      rows.push(cbar(w.label, w.pct, w.pct.toFixed(0) + '%', p.sub, p.cls, p.tip));
    }
  } else {
    // No fresh OAuth token: approximate the 5h window from transcripts.
    const cb2 = data.currentBlock;
    if (cb2) {
      const elapsed = 1 - cb2.remainingMs / (5 * 3600000);
      rows.push(cbar('5h window (time)', elapsed * 100, money(cb2.cost), dur(cb2.remainingMs) + ' left'));
    }
  }

  if (rows.length) rows.push('<div class="csep"></div>');
  const s = data.activeSessions[0] || data.sessions[0];
  if (s && s.context) {
    rows.push(cbar(
      (s.active ? '● ' : '') + 'Context',
      s.context.pct,
      s.context.pct.toFixed(0) + '%',
      tokens(s.context.used) + ' / ' + tokens(s.context.max)
    ));
  }

  // Per-model spend this week: one stacked bar, each model a colored segment.
  const wmAll = Object.entries(data.weekByModel || {}).sort((a, b) => b[1] - a[1]);
  const weekTotal = data.totals.week.cost || 0;
  if (wmAll.length && weekTotal > 0) {
    const top = wmAll.slice(0, 4);
    const otherCost = wmAll.slice(4).reduce((s, [, c]) => s + c, 0);
    if (otherCost > 0) top.push(['other', otherCost]);
    const pickColor = makeColorPicker();
    const colored = top.map(([m, c]) => [m, c, pickColor(m)]);
    const segs = colored.map(([m, c, col]) =>
      `<i style="width:${((c / weekTotal) * 100).toFixed(1)}%;background:${col}" title="${esc(shortModel(m))} ${money(c)}"></i>`
    ).join('');
    const legend = colored.map(([m, c, col]) =>
      `<span><span class="cdot" style="background:${col}"></span>${esc(shortModel(m))} ${money(c)}</span>`
    ).join('');
    rows.push('<div class="csep"></div>');
    rows.push(`<div class="cbar-row">
      <span class="cname">Week by model</span>
      <span class="cstack">${segs}</span>
      <span class="cval">${money(weekTotal)}</span>
      <span class="csub">&nbsp;</span>
    </div>
    <div class="clegend">${legend}</div>`);
  }

  let note = '';
  if (lim && !lim.ok) {
    note = `<div class="cnote">official limit %s unavailable — ${esc(friendlyLimitError(lim.error))}</div>`;
  } else if (lim && lim.stale) {
    note = `<div class="cnote">limits last updated ${hm(lim.fetchedAt)} (${esc(friendlyLimitError(lim.staleError))})</div>`;
  }

  const savings = savingsLine();

  content.innerHTML = `<div id="cwrap">
    ${rows.join('')}
    <div class="cfoot">today <b>${money(t.today.cost)}</b> · week <b>${money(t.week.cost)}</b> · month <b>${money(t.month.cost)}</b></div>
    ${savings}
    ${note}
  </div>`;

  // Fit the compact window to its content. Measure the inner wrapper — the
  // content container flex-stretches to the window, so measuring it directly
  // would let the window grow but never shrink.
  requestAnimationFrame(() => {
    const wrap = $('#cwrap');
    if (!wrap) return;
    const h = document.querySelector('.titlebar').offsetHeight + wrap.offsetHeight + 26;
    window.hud.reportHeight(Math.max(120, Math.min(430, h)));
  });
}

function baseModelColor(m) {
  const id = String(m).toLowerCase();
  if (id.includes('fable') || id.includes('mythos')) return '#d97757';
  if (id.includes('opus')) return '#7aa2f7';
  if (id.includes('sonnet')) return '#6fbf73';
  if (id.includes('haiku')) return '#b48ead';
  return '#7d7d7d';
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Same-family models (opus-5 vs opus-4-8) get progressively darker shades so
// their segments stay distinguishable in the stacked bar.
function makeColorPicker() {
  const familyCount = {};
  return (m) => {
    const base = baseModelColor(m);
    const n = familyCount[base] || 0;
    familyCount[base] = n + 1;
    return n === 0 ? base : shade(base, 1 - 0.3 * n);
  };
}

function friendlyLimitError(err) {
  const e = String(err || '');
  if (e.includes('401')) return 'login token expired; run the claude CLI once to refresh it';
  if (e.includes('429')) return 'rate-limited by the API, retrying in a few minutes';
  if (e.includes('credentials')) return 'no Claude login found';
  return e;
}

// "What would this month have cost at API prices vs my subscription?"
function savingsLine() {
  if (!settings || !settings.planPrice || settings.planPrice <= 0) return '';
  const m = data.totals.month.cost;
  const saved = m - settings.planPrice;
  const mult = m / settings.planPrice;
  if (m < settings.planPrice) {
    return `<div class="cnote">${esc(settings.planName)} $${settings.planPrice}/mo · ${money(m)} used so far (${(mult * 100).toFixed(0)}% of plan price)</div>`;
  }
  return `<div class="cnote">${esc(settings.planName)} $${settings.planPrice}/mo → <b class="cost">saved ${money(saved)}</b> vs API this month (${mult.toFixed(1)}× value)</div>`;
}

const renderers = {
  overview: renderOverview,
  sessions: renderSessions,
  models: renderModels,
  daily: renderDaily,
  blocks: renderBlocks,
  settings: renderSettings,
};

function render() {
  if (settings && settings.compact) {
    if (data) renderCompact();
    return;
  }
  if (activeTab === 'settings') { renderSettings(); return; }
  if (!data) return;
  renderers[activeTab]();
  $('#status-left').textContent = `updated ${hm(data.generatedAt)}`;
  $('#status-right').textContent = `${data.entryCount.toLocaleString()} messages tracked`;
}

// ---------- wiring ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    render();
  });
});

// Drag-anywhere: any non-interactive spot moves the window (scrollbar excluded).
const INTERACTIVE = 'button, input, textarea, select, a';
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(INTERACTIVE)) return;
  const sc = e.target.closest('.content');
  if (sc && e.clientX > sc.getBoundingClientRect().right - 16) return; // scrollbar
  window.hud.dragStart();
});
document.addEventListener('mouseup', () => window.hud.dragEnd());
window.addEventListener('blur', () => window.hud.dragEnd());

$('#btn-pin').addEventListener('click', () => window.hud.setPinned(true));
$('#btn-hide').addEventListener('click', () => window.hud.hide());
$('#btn-compact').addEventListener('click', () => window.hud.setCompact(!(settings && settings.compact)));

window.hud.onData((d) => { data = d; if (settings && settings.compact) { renderCompact(); } else if (activeTab !== 'settings') render(); else { $('#status-left').textContent = `updated ${hm(d.generatedAt)}`; } });
window.hud.onError((msg) => { $('#status-left').textContent = 'error: ' + msg; });
window.hud.onPinned((pinned) => {
  $('#app').classList.toggle('pinned', pinned);
  $('#pin-hint').classList.toggle('hidden', !pinned);
});
window.hud.onHover((inside) => $('#app').classList.toggle('hot', inside));
window.hud.onSettings((s) => {
  settings = s;
  document.documentElement.style.setProperty('--idle-opacity', s.idleOpacity);
  $('#app').classList.toggle('compact', !!s.compact);
  render();
});

(async () => {
  settings = await window.hud.getSettings();
  document.documentElement.style.setProperty('--idle-opacity', settings.idleOpacity);
  $('#app').classList.toggle('compact', !!settings.compact);
  const d = await window.hud.getData();
  if (d) { data = d; render(); }
})();
