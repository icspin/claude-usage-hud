'use strict';

const { entryCost, findRates } = require('./pricing');

const HOUR = 3600 * 1000;
const BLOCK_MS = 5 * HOUR;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function emptyBucket() {
  return { cost: 0, input: 0, output: 0, cacheRead: 0, w5m: 0, w1h: 0, messages: 0 };
}

function addTo(bucket, e, cost) {
  bucket.cost += cost;
  bucket.input += e.input;
  bucket.output += e.output;
  bucket.cacheRead += e.cacheRead;
  bucket.w5m += e.w5m;
  bucket.w1h += e.w1h;
  bucket.messages += 1;
}

// entries: sorted ascending by ts. sessionMeta: Map(sessionId -> {name, cwd, updatedAt}).
function aggregate(entries, sessionMeta, pricing, now = Date.now()) {
  const todayStart = startOfLocalDay(now);
  const weekStart = todayStart - 6 * 24 * HOUR;
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  const totals = {
    today: emptyBucket(),
    week: emptyBucket(),
    month: emptyBucket(),
    allTime: emptyBucket(),
  };
  const todayByModel = {};
  const perModel = {};
  const sessions = new Map();
  const daily = new Map();
  const blocks = [];
  let block = null;

  for (const e of entries) {
    const cost = entryCost(pricing, e.model, e);

    addTo(totals.allTime, e, cost);
    if (e.ts >= todayStart) {
      addTo(totals.today, e, cost);
      todayByModel[e.model] = (todayByModel[e.model] || 0) + cost;
    }
    if (e.ts >= weekStart) addTo(totals.week, e, cost);
    if (e.ts >= monthStart) addTo(totals.month, e, cost);

    let pm = perModel[e.model];
    if (!pm) pm = perModel[e.model] = { ...emptyBucket(), lastTs: 0 };
    addTo(pm, e, cost);
    if (e.ts > pm.lastTs) pm.lastTs = e.ts;

    let s = sessions.get(e.sessionId);
    if (!s) {
      s = { id: e.sessionId, projectDir: e.projectDir, firstTs: e.ts, lastTs: e.ts, models: {}, lastEntry: null, ...emptyBucket() };
      sessions.set(e.sessionId, s);
    }
    addTo(s, e, cost);
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts >= s.lastTs) { s.lastTs = e.ts; s.lastEntry = e; }
    s.models[e.model] = (s.models[e.model] || 0) + cost;

    const dk = dayKey(e.ts);
    let day = daily.get(dk);
    if (!day) { day = { date: dk, byModel: {}, ...emptyBucket() }; daily.set(dk, day); }
    addTo(day, e, cost);
    day.byModel[e.model] = (day.byModel[e.model] || 0) + cost;

    // 5-hour billing-style blocks: a block opens at the top of the hour of the
    // first message past the previous block's end (same convention as ccusage).
    if (!block || e.ts >= block.start + BLOCK_MS) {
      const start = Math.floor(e.ts / HOUR) * HOUR;
      block = { start, end: start + BLOCK_MS, byModel: {}, ...emptyBucket() };
      blocks.push(block);
    }
    addTo(block, e, cost);
    block.byModel[e.model] = (block.byModel[e.model] || 0) + cost;
  }

  // Session list, newest activity first, decorated with metadata + context usage.
  const sessionList = [...sessions.values()]
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, 200)
    .map((s) => {
      const meta = sessionMeta.get(s.id);
      const last = s.lastEntry;
      let context = null;
      if (last) {
        const used = last.input + last.cacheRead + last.w5m + last.w1h;
        const r = findRates(pricing, last.model);
        context = { used, max: r.context, pct: Math.min(100, (used / r.context) * 100) };
      }
      return {
        id: s.id,
        title: (meta && meta.name) || null,
        cwd: (meta && meta.cwd) || null,
        projectDir: s.projectDir,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        active: now - s.lastTs < ACTIVE_WINDOW_MS,
        cost: s.cost,
        input: s.input,
        output: s.output,
        cacheRead: s.cacheRead,
        cacheWrite: s.w5m + s.w1h,
        messages: s.messages,
        models: s.models,
        context,
      };
    });

  const dailyList = [...daily.values()].sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 60);

  const currentBlock = block && now < block.end ? block : null;
  const blockList = blocks.slice(-30).reverse();

  return {
    generatedAt: now,
    totals,
    todayByModel,
    perModel,
    sessions: sessionList,
    activeSessions: sessionList.filter((s) => s.active),
    daily: dailyList,
    blocks: blockList,
    currentBlock: currentBlock
      ? { ...currentBlock, remainingMs: currentBlock.end - now }
      : null,
    entryCount: entries.length,
  };
}

module.exports = { aggregate };
