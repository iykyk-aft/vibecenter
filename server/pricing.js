// Model pricing in USD per 1,000,000 tokens.
// Cache-write: 1.25x input for 5-minute TTL entries, 2x input for 1-hour TTL
// (current Claude Code sessions write almost exclusively 1h entries).
// Cache-read = 0.1x input. Fast mode (Opus 5 / Opus 4.8) bills at $10/$50.
// Source: Anthropic pricing, verified 2026-08. Edit freely — costs recompute live.

export const PRICING = {
  'claude-fable-5':    { input: 10, output: 50 },
  'claude-mythos-5':   { input: 10, output: 50 },
  'claude-opus-5':     { input: 5,  output: 25 },
  'claude-opus-4-8':   { input: 5,  output: 25 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-opus-4-6':   { input: 5,  output: 25 },
  'claude-opus-4-5':   { input: 5,  output: 25 },
  'claude-sonnet-5':   { input: 2,  output: 10 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-sonnet-4-5': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5  },
};

// Premium rates when a message ran in fast mode (usage.speed === 'fast').
const FAST_PRICING = {
  'claude-opus-5':   { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 },
};

// Fallback for unknown / future model ids — assume Opus-tier so we never
// silently undercount.
const DEFAULT_RATE = { input: 5, output: 25 };

// Longest-prefix-first so 'claude-haiku-4-5-20251001' hits 'claude-haiku-4-5'
// and 'claude-opus-4-8' never falls through to a shorter cousin.
const KEYS_BY_LEN = Object.keys(PRICING).sort((a, b) => b.length - a.length);

// rate + how we resolved it, for the UI's "estimated vs exact pricing" flag.
export function priceMeta(model, speed) {
  const norm = String(model || '').replace(/\[1m\]\s*$/i, '');
  if (!norm) return { ...DEFAULT_RATE, via: 'default' };
  if (speed === 'fast' && FAST_PRICING[norm]) return { ...FAST_PRICING[norm], via: 'fast' };
  if (PRICING[norm]) return { ...PRICING[norm], via: 'exact' };
  for (const key of KEYS_BY_LEN) {
    if (norm.startsWith(key)) {
      if (speed === 'fast' && FAST_PRICING[key]) return { ...FAST_PRICING[key], via: 'fast' };
      return { ...PRICING[key], via: 'exact' };
    }
  }
  // Loose family match for dated snapshots / future releases.
  if (/sonnet-5/.test(norm)) return { input: 2, output: 10, via: 'family' };
  if (norm.includes('opus')) return { input: 5, output: 25, via: 'family' };
  if (norm.includes('sonnet')) return { input: 3, output: 15, via: 'family' };
  if (norm.includes('haiku')) return { input: 1, output: 5, via: 'family' };
  if (norm.includes('fable') || norm.includes('mythos')) return { input: 10, output: 50, via: 'family' };
  return { ...DEFAULT_RATE, via: 'default' };
}

function rateFor(model, speed) { return priceMeta(model, speed); }

// usage: { input, output, cacheCreation, cacheRead } raw token counts, plus
// optionally the TTL split { cacheCreation5m, cacheCreation1h }. When the split
// is present it is authoritative (1h writes bill 2x); without it we fall back
// to pricing all writes at the 5m rate (1.25x) — old transcripts lack the split.
// opts.speed === 'fast' applies fast-mode premium rates where they exist.
export function costFor(model, usage, opts = {}) {
  const r = rateFor(model, opts.speed);
  const cc1h = usage.cacheCreation1h || 0;
  let cc5m = usage.cacheCreation5m || 0;
  if (!cc1h && !cc5m) cc5m = usage.cacheCreation || 0; // legacy: no split known
  return (
    (usage.input || 0) * r.input +
    (usage.output || 0) * r.output +
    cc5m * r.input * 1.25 +
    cc1h * r.input * 2 +
    (usage.cacheRead || 0) * r.input * 0.1
  ) / 1_000_000;
}

export function prettyModel(model) {
  if (!model) return 'unknown';
  let m = String(model)
    .replace(/\[1m\]\s*$/i, '')      // long-context settings suffix
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');          // dated snapshot suffix
  m = m.replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1');
  return m.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
