'use strict';

// Taskbar strip: a glanceable summary of the HUD and the capture pipeline.
// Clicking either half asks the main process to toggle the full view.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '$' + (n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(0));

function shortLabel(label) {
  const l = String(label);
  if (/session/i.test(l)) return '5h';
  const m = l.match(/^Week \((.+)\)$/i);
  if (m) return /all models/i.test(m[1]) ? 'Week' : m[1];
  return l.length > 8 ? l.slice(0, 8) : l;
}

// Same maths as the HUD's pace notch (renderer/app.js evenPacePct): where an
// evenly-paced user would sit right now = fraction of the window elapsed.
function windowMsFor(w) {
  const k = String(w.key || '');
  return (k.startsWith('session') || k === 'five_hour') ? 5 * 3600000 : 7 * 24 * 3600000;
}
function evenPacePct(w) {
  if (!w.resetsAt) return null;
  const windowMs = windowMsFor(w);
  const elapsed = windowMs - (w.resetsAt - Date.now());
  if (elapsed < 0 || elapsed > windowMs) return null;
  return (elapsed / windowMs) * 100;
}

function renderUsage(data) {
  if (!data || !data.totals) return;
  const lim = data.limits;
  const out = [];
  if (lim && lim.ok && lim.windows && lim.windows.length) {
    for (const w of lim.windows) {
      if (w.key === 'seven_day_sonnet' && w.pct === 0) continue;
      const expired = w.resetsAt && w.resetsAt < Date.now();
      const pct = expired ? 0 : w.pct;
      const cls = expired || lim.stale ? 'stale' : pct >= 80 ? 'hot' : pct >= 60 ? 'warn' : '';
      out.push(`<div class="b ${cls}"><div class="top"><span class="n">${esc(shortLabel(w.label))}</span>` +
        `<span class="v">${expired ? '-' : pct.toFixed(0) + '%'}</span></div>` +
        `<div class="track"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i>${tickHtml(w)}</div></div>`);
      if (out.length >= 4) break;
    }
  }
  $('bars').innerHTML = out.length ? out.join('') : '<span class="dim">limits unavailable</span>';
  const t = data.totals;
  $('money').innerHTML = `<span><b>${money(t.today.cost)}</b> today</span><span>${money(t.week.cost)} week</span>`;
}

function tickHtml(w) {
  const t = evenPacePct(w);
  if (!Number.isFinite(t)) return '';
  return `<u class="tick" style="left:${Math.max(0, Math.min(100, t)).toFixed(1)}%" title="even pace ${t.toFixed(0)}%"></u>`;
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

let cap = null;
let rot = 0;
function setStatus(st) {
  const el = $('cap');
  el.classList.remove('st-rec', 'st-ok', 'st-bad', 'st-work');
  el.classList.add('st-' + st);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pctTxt = (p) => (Number.isFinite(p) ? ` ${Math.round(p)}%` : '');

// One entry per active thing; line 2 cycles through them.
function items(c) {
  const out = [];
  for (const r of c.rec) {
    out.push(r.finishing
      ? `<b>${esc(r.name)}</b> finishing &middot; ${r.mb.toLocaleString()} MB`
      : `<b>${esc(r.name)}</b> ${fmtDur(r.elapsed)} &middot; ${r.mb.toLocaleString()} MB &middot; ${r.chat.toLocaleString()} chat`);
  }
  for (const w of c.work) {
    if (w.kind === 'render') out.push(`<b>${esc(w.name)}</b> rendering${pctTxt(w.pct)} &middot; ${esc(w.detail)}`);
    else if (w.kind === 'upload') out.push(`<b>${esc(w.name)}</b> uploading${pctTxt(w.pct)}`);
    else if (w.kind === 'failed') out.push(`<b>${esc(w.name)}</b> render FAILED &middot; ${esc(w.detail)}`);
  }
  return out;
}

function renderCap() {
  const dot = $('dot');
  $('cap').style.display = cap && cap.disabled ? 'none' : '';
  if (cap && cap.disabled) return;
  if (!cap || !cap.ok) {
    dot.className = 'dot bad';
    setStatus('bad');
    $('cap1').innerHTML = '<span class="warnc">Capture dashboard offline</span>';
    $('cap2').textContent = cap && cap.error ? cap.error : 'no answer from the dashboard';
    return;
  }
  const down = cap.total - cap.alive;
  const nRec = cap.rec.length;
  const nRender = cap.work.filter((w) => w.kind === 'render').length;
  const nUp = cap.work.filter((w) => w.kind === 'upload').length;
  const nFail = cap.work.filter((w) => w.kind === 'failed').length;

  // Headline: counts of everything active, most important first.
  const head = [];
  if (nRec) head.push(`${nRec} REC`);
  if (nRender) head.push(`${nRender} RENDER`);
  if (nUp) head.push(`${nUp} UPLOAD`);
  if (cap.queued) head.push(`${cap.queued} QUEUED`);
  if (nFail) head.push(`<span class="warnc">${nFail} FAILED</span>`);
  if (down) head.push(`<span class="warnc">${plural(down, 'runner')} down</span>`);

  // Colour = most urgent state.
  const st = nRec ? 'rec' : (nFail || down) ? 'bad' : (nRender || nUp) ? 'work' : 'ok';
  setStatus(st);
  dot.className = 'dot ' + (st === 'rec' ? 'rec' : st === 'bad' ? 'bad' : 'ok');

  const list = items(cap);
  if (!head.length && !list.length) {
    $('cap1').innerHTML = `Watching <span class="dim">${cap.alive}/${cap.total}</span>`;
    $('cap2').textContent = cap.held ? `nobody live · ${cap.held} held` : 'nobody live';
    return;
  }
  $('cap1').innerHTML = head.join(' <span class="dim">&middot;</span> ') || `Watching ${cap.alive}/${cap.total}`;
  if (list.length) {
    const i = rot % list.length;
    $('cap2').innerHTML = list[i] + (list.length > 1 ? ` <span class="dim">&middot; ${i + 1}/${list.length}</span>` : '');
  } else {
    $('cap2').textContent = `watching ${cap.alive}/${cap.total}`;
  }
}

// Several things at once: cycle line 2 so each gets its turn.
setInterval(() => { rot++; if (cap && cap.ok) renderCap(); }, 4000);

window.strip.onUsage(renderUsage);
window.strip.onCap((s) => { cap = s; renderCap(); });
window.strip.onOpen((o) => {
  $('hud').classList.toggle('open', !!o.hud);
  $('cap').classList.toggle('open', !!o.cap);
});

for (const kind of ['hud', 'cap']) {
  $(kind).addEventListener('click', () => {
    const r = $(kind).getBoundingClientRect();
    window.strip.click(kind, Math.round(r.left));
  });
}
document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.strip.menu(); });
window.strip.ready();
