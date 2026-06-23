// Model pricing in USD per 1,000,000 tokens.
// Cache-write = 1.25x input (5-minute TTL). Cache-read = 0.1x input.
// Source: Anthropic pricing (Opus 4.8 $5/$25, Sonnet 4.6 $3/$15,
// Haiku 4.5 $1/$5, Fable 5 $10/$50). Edit freely — costs recompute live.

export const PRICING = {
  'claude-opus-4-8':  { input: 5,  output: 25 },
  'claude-opus-4-7':  { input: 5,  output: 25 },
  'claude-opus-4-6':  { input: 5,  output: 25 },
  'claude-opus-4-5':  { input: 5,  output: 25 },
  'claude-sonnet-4-6':{ input: 3,  output: 15 },
  'claude-sonnet-4-5':{ input: 3,  output: 15 },
  'claude-haiku-4-5': { input: 1,  output: 5  },
  'claude-fable-5':   { input: 10, output: 50 },
  'claude-mythos-5':  { input: 10, output: 50 },
};

// Fallback for unknown / future model ids — assume Opus-tier so we never
// silently undercount.
const DEFAULT_RATE = { input: 5, output: 25 };

function rateFor(model) {
  if (!model) return DEFAULT_RATE;
  if (PRICING[model]) return PRICING[model];
  // Loose match on family so dated snapshots still price correctly.
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  if (model.includes('opus')) return { input: 5, output: 25 };
  if (model.includes('sonnet')) return { input: 3, output: 15 };
  if (model.includes('haiku')) return { input: 1, output: 5 };
  if (model.includes('fable') || model.includes('mythos')) return { input: 10, output: 50 };
  return DEFAULT_RATE;
}

// usage: { input, output, cacheCreation, cacheRead } in raw token counts.
export function costFor(model, usage) {
  const r = rateFor(model);
  const cacheWrite = r.input * 1.25;
  const cacheRead = r.input * 0.1;
  return (
    (usage.input || 0) * r.input +
    (usage.output || 0) * r.output +
    (usage.cacheCreation || 0) * cacheWrite +
    (usage.cacheRead || 0) * cacheRead
  ) / 1_000_000;
}

export function prettyModel(model) {
  if (!model) return 'unknown';
  return model
    .replace('claude-', '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
