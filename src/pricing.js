'use strict';

// Prices are USD per 1M tokens (MTok). Cache multipliers apply to the input rate:
//   cache read = 0.1x input, 5-minute cache write = 1.25x input, 1-hour cache write = 2x input.
// Order matters: first match (substring of the model id) wins, so specific
// legacy ids must come before the generic family match.
const DEFAULT_PRICING = {
  cacheReadMult: 0.1,
  cacheWrite5mMult: 1.25,
  cacheWrite1hMult: 2.0,
  models: [
    { match: 'fable',        label: 'Fable 5',       in: 10,   out: 50,   context: 1000000 },
    { match: 'mythos',       label: 'Mythos 5',      in: 10,   out: 50,   context: 1000000 },
    { match: 'opus-4-1',     label: 'Opus 4.1',      in: 15,   out: 75,   context: 200000 },
    { match: 'opus-4-2025',  label: 'Opus 4',        in: 15,   out: 75,   context: 200000 },
    { match: 'opus',         label: 'Opus',          in: 5,    out: 25,   context: 1000000 },
    { match: 'sonnet-5',     label: 'Sonnet 5',      in: 3,    out: 15,   context: 1000000 },
    { match: 'sonnet',       label: 'Sonnet',        in: 3,    out: 15,   context: 1000000 },
    { match: '3-5-haiku',    label: 'Haiku 3.5',     in: 0.8,  out: 4,    context: 200000 },
    { match: 'haiku-4',      label: 'Haiku 4.5',     in: 1,    out: 5,    context: 200000 },
    { match: 'haiku',        label: 'Haiku 3',       in: 0.25, out: 1.25, context: 200000 },
  ],
  // Anything that matches nothing above falls back to this.
  fallback: { label: 'Unknown', in: 5, out: 25, context: 200000 },
};

function findRates(pricing, modelId) {
  const id = String(modelId || '').toLowerCase();
  for (const m of pricing.models) {
    if (id.includes(m.match)) return m;
  }
  return pricing.fallback;
}

// entry: { input, output, cacheRead, w5m, w1h }
function entryCost(pricing, modelId, e) {
  const r = findRates(pricing, modelId);
  return (
    e.input * r.in +
    e.output * r.out +
    e.cacheRead * r.in * pricing.cacheReadMult +
    e.w5m * r.in * pricing.cacheWrite5mMult +
    e.w1h * r.in * pricing.cacheWrite1hMult
  ) / 1e6;
}

module.exports = { DEFAULT_PRICING, findRates, entryCost };
