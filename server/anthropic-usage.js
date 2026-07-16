// Wraps Anthropic's Admin Usage & Cost API so the dashboard can show real
// billed cost/tokens instead of the local per-transcript estimate.
// Docs: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
//
// Requires an Admin API key (sk-ant-admin01-…) created in
// Console → Settings → Admin keys. Only available for Claude Console
// organizations — individual claude.ai subscriptions can't create one.
const API_BASE = 'https://api.anthropic.com/v1/organizations';
const ANTHROPIC_VERSION = '2023-06-01';

// keyed by `${adminKey.slice(-6)}:${since}:${until}` -> { ts, data }
const summaryCache = new Map();
// Anthropic: "supports polling once per minute for sustained use" — cache a
// little longer than that so repeated dashboard loads don't hammer it.
const SUMMARY_TTL_MS = 2 * 60 * 1000;

async function callAdmin(pathname, params, adminKey) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((item) => qs.append(`${k}[]`, item));
    else qs.set(k, v);
  }
  const res = await fetch(`${API_BASE}${pathname}?${qs.toString()}`, {
    headers: {
      'x-api-key': adminKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'User-Agent': 'vibecenter-command-center/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Anthropic Admin API ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function paginate(pathname, baseParams, adminKey, maxPages) {
  const out = [];
  let page;
  for (let i = 0; i < maxPages; i++) {
    const data = await callAdmin(pathname, { ...baseParams, page }, adminKey);
    out.push(...(data.data || []));
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return out;
}

// group_by[]=description returns per-model cost with `amount` as a decimal
// string in *cents* (e.g. "123.45" == $1.23).
function costReportRaw(adminKey, startingAt, endingAt) {
  return paginate('/cost_report',
    { starting_at: startingAt, ending_at: endingAt, bucket_width: '1d', group_by: ['description'], limit: 31 },
    adminKey, 60);
}
function usageReportRaw(adminKey, startingAt, endingAt) {
  return paginate('/usage_report/messages',
    { starting_at: startingAt, ending_at: endingAt, bucket_width: '1d', group_by: ['model'], limit: 31 },
    adminKey, 60);
}

// Merged real cost + token summary for [since, until). Falls back to a stale
// cached copy on transient errors so a flaky call doesn't blank the card.
export async function adminUsageSummary(adminKey, { since, until } = {}) {
  if (!adminKey) return { ok: false, reason: 'no-key' };
  const untilDate = until || new Date();
  const sinceDate = since || new Date(untilDate.getTime() - 30 * 24 * 3600 * 1000);
  const startingAt = sinceDate.toISOString();
  const endingAt = untilDate.toISOString();
  const cacheKey = `${adminKey.slice(-6)}:${startingAt}:${endingAt}`;

  const hit = summaryCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < SUMMARY_TTL_MS) return hit.data;

  try {
    const [costBuckets, usageBuckets] = await Promise.all([
      costReportRaw(adminKey, startingAt, endingAt),
      usageReportRaw(adminKey, startingAt, endingAt),
    ]);

    const byModel = new Map();
    const touch = (m) => {
      if (!byModel.has(m)) byModel.set(m, { model: m, costUSD: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
      return byModel.get(m);
    };
    const daily = {};
    let totalCostUSD = 0;

    for (const bucket of costBuckets) {
      const day = (bucket.starting_at || '').slice(0, 10);
      for (const r of bucket.results || []) {
        const usd = Number(r.amount || 0) / 100; // amount is in cents
        totalCostUSD += usd;
        daily[day] = (daily[day] || 0) + usd;
        touch(r.model || 'other').costUSD += usd;
      }
    }
    for (const bucket of usageBuckets) {
      for (const r of bucket.results || []) {
        const m = touch(r.model || 'unknown');
        m.inputTokens += r.uncached_input_tokens || 0;
        m.outputTokens += r.output_tokens || 0;
        m.cacheCreationTokens += (r.cache_creation && (r.cache_creation.ephemeral_5m_input_tokens || 0) + (r.cache_creation.ephemeral_1h_input_tokens || 0)) || 0;
        m.cacheReadTokens += r.cache_read_input_tokens || 0;
      }
    }

    const data = {
      ok: true,
      since: startingAt,
      until: endingAt,
      totalCostUSD,
      daily,
      byModel: [...byModel.values()]
        .filter((m) => m.costUSD > 0 || m.inputTokens > 0 || m.outputTokens > 0)
        .sort((a, b) => b.costUSD - a.costUSD),
      fetchedAt: Date.now(),
    };
    summaryCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (e) {
    if (hit) return { ...hit.data, stale: true, error: e.message };
    let reason = 'error';
    if (e.status === 401) reason = 'invalid-key';
    else if (e.status === 403) reason = 'forbidden';
    return { ok: false, reason, error: e.message, status: e.status || null };
  }
}
