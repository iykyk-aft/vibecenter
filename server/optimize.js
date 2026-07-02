// Cost optimizer — turns the parsed transcript metrics into a ranked list of
// concrete "make Claude cheaper" recommendations, each with an action the
// dashboard can apply with one click. Pure analysis over data we already have;
// the only side effect lives in setDefaultModel() (writes ~/.claude/settings.json).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costFor, prettyModel } from './pricing.js';

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const STATE_FILE = path.join(process.cwd(), 'data', 'optimizer.json');
// Aliases Claude Code understands in settings.json `model` — kept loose so a
// version bump (sonnet 4.6 → 4.7) doesn't strand the setting on a dead id.
const SAFE_MODELS = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' };

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
  catch { /* best-effort */ }
}

// The model Claude Code currently defaults new sessions to (null = the app's
// own default, i.e. Opus on a Max plan).
export function currentDefaultModel() {
  const s = readSettings();
  return typeof s.model === 'string' && s.model ? s.model : null;
}

// The exact model that was in settings.json before the optimizer first changed
// it — so "Restore" puts back e.g. "opus[1m]" verbatim, not a lossy alias.
export function prevDefaultModel() {
  const p = readState().prevModel;
  return typeof p === 'string' && p ? p : null;
}

function backupSettings() {
  try {
    const dir = path.join(process.cwd(), 'data', 'settings-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, path.join(dir, `settings.${stamp}.json`));
  } catch { /* best-effort */ }
}

// Reversible: set (or clear, when model is null/'') the default model. Every
// write is backed up first, so "Restore" is always a click away. We accept the
// three managed aliases, plus the exact previous value (so a restore can put
// back a custom id like "opus[1m]" without flattening it to "opus").
export function setDefaultModel(model) {
  const wantClear = model == null || model === '';
  const raw = String(model);
  const prev = prevDefaultModel();
  const current = currentDefaultModel();
  const alias = wantClear ? '' : SAFE_MODELS[raw.toLowerCase()];
  // Also accept the current model with its [1m] long-context suffix stripped,
  // so "turn off 1M context, keep the same model" is a one-click action.
  const strip1m = (m) => String(m || '').replace(/\[1m\]\s*$/i, '');
  const allowed = wantClear || alias !== undefined || raw === prev || raw === current
    || (current && raw === strip1m(current));
  if (!allowed) return { ok: false, error: 'unsupported model' };
  const s = readSettings();
  // Capture the displaced model once, before our first overwrite, so restore is exact.
  if (current && prevDefaultModel() == null && current !== alias) {
    writeState({ ...readState(), prevModel: current });
  }
  backupSettings();
  const value = alias !== undefined && alias !== '' ? alias : (wantClear ? '' : raw);
  if (!value) delete s.model; else s.model = value;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, model: value || null };
}

const isPremium = (m) => /opus|fable|mythos/i.test(m || '');
const emptyUsage = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// projects: from listProjects(); account: from accountPayload(); plan/budgets
// straight off config. Returns the full payload the Savings screen renders.
export function buildRecommendations({ projects, account, plan, budgets, runs }) {
  const metered = !plan || plan.metered;
  budgets = budgets || {};
  runs = runs || [];

  // ---- one pass over every session: per-model spend, live + heavy sessions ---
  const perModel = {}; // model -> { usage, cost, tokens }
  let totalCost = 0;
  const live = [];     // sessions touched in the last ~10 min (still open)
  const heavy = [];    // sessions carrying very large contexts
  const ctxHeavy = []; // sessions where re-read context is the real spend
  let cacheReadCostTotal = 0;
  for (const p of projects) {
    for (const s of p.sessions || []) {
      for (const [m, info] of Object.entries(s.models || {})) {
        if (!perModel[m]) perModel[m] = { usage: emptyUsage(), cost: 0, tokens: 0 };
        const u = info.usage || {};
        perModel[m].usage.input += u.input || 0;
        perModel[m].usage.output += u.output || 0;
        perModel[m].usage.cacheCreation += u.cacheCreation || 0;
        perModel[m].usage.cacheRead += u.cacheRead || 0;
        perModel[m].cost += info.cost || 0;
        perModel[m].tokens += info.tokens || 0;
        totalCost += info.cost || 0;
      }
      if (s.active) live.push({ session: s.id, project: p.id, projectName: p.name, title: s.title, cost: s.cost, mtime: s.mtime });
      if (s.billableTokens >= 400_000) {
        heavy.push({ session: s.id, project: p.id, projectName: p.name, title: s.title, cost: s.cost, tokens: s.billableTokens });
      }
      // Context weight: every assistant message re-reads the whole session
      // context (as cache reads), so cost ≈ context size × message count.
      const crTok = (s.tokens && s.tokens.cacheRead) || 0;
      if (crTok > 0) {
        const crCost = Object.entries(s.models || {}).reduce((a, [m, i]) =>
          a + costFor(m, { cacheRead: (i.usage && i.usage.cacheRead) || 0 }), 0);
        const ctxPerMsg = s.assistantMessages > 0 ? crTok / s.assistantMessages : 0;
        if (crCost >= 1) ctxHeavy.push({
          session: s.id, project: p.id, projectName: p.name, title: s.title,
          crCost, ctxPerMsg, msgs: s.assistantMessages,
        });
        cacheReadCostTotal += crCost;
      }
    }
  }

  // Share of recent spend, used to turn lifetime deltas into a monthly estimate.
  const monthCost = (account.ranges && account.ranges.month && account.ranges.month.cost) || 0;
  const monthlyFactor = totalCost > 0 ? Math.min(1, monthCost / totalCost) : 0;

  const recs = [];

  // ---- R0: 1M-context default model ------------------------------------------
  // The [1m] long-context variant bills input past 200K at premium rates, and a
  // default applies to EVERY new session — most of which never need 1M context.
  const defModel = currentDefaultModel();
  if (defModel && /\[1m\]\s*$/i.test(defModel)) {
    const plain = defModel.replace(/\[1m\]\s*$/i, '');
    recs.push({
      id: 'long-context-default',
      severity: 'high',
      icon: '🧠',
      title: '1M-context mode is your default for every session',
      metric: `default model: ${defModel}`,
      detail: `Every new session on this machine starts on ${prettyModel(plain)} with the [1m] long-context beta. Once a session's context passes 200K tokens, [1m] bills input and cache at roughly double the standard rate — and it burns rate-limit headroom much faster on a Max plan. Keep [1m] for the rare session that truly needs a giant context (switch per-session with /model), not as the default.`,
      estSavings: null,
      currentModel: defModel,
      actions: [
        { kind: 'set-model', model: plain, label: `Keep ${prettyModel(plain)}, drop [1m]`, primary: true },
        { kind: 'set-model', model: 'sonnet', label: 'Default to Sonnet (cheaper)' },
      ],
      footnote: 'Reversible — every change backs up settings.json first, and "Restore" puts the exact previous value back.',
    });
  }

  // ---- R1: right-size the model ---------------------------------------------
  let premiumCost = 0, premiumAsSonnet = 0, premiumAsHaiku = 0;
  for (const [m, v] of Object.entries(perModel)) {
    if (!isPremium(m)) continue;
    premiumCost += v.cost;
    premiumAsSonnet += costFor('claude-sonnet-4-6', v.usage);
    premiumAsHaiku += costFor('claude-haiku-4-5', v.usage);
  }
  const premiumShare = totalCost > 0 ? premiumCost / totalCost : 0;
  const sonnetDelta = Math.max(0, premiumCost - premiumAsSonnet);
  const curModel = currentDefaultModel();
  const restoreModel = prevDefaultModel() || curModel; // exact value to put back
  if (premiumShare >= 0.5 && sonnetDelta > 0 && premiumCost > 0.5) {
    // Conservative: assume ~40% of premium work is routine enough for Sonnet.
    const monthlyFull = sonnetDelta * monthlyFactor;
    const est = monthlyFull * 0.4;
    recs.push({
      id: 'right-size-model',
      severity: premiumShare >= 0.8 ? 'high' : 'med',
      icon: '🎚️',
      title: 'Right-size your default model',
      metric: `${Math.round(premiumShare * 100)}% of spend is on premium models`,
      detail: `${metered ? 'You\'ve spent' : 'API-equivalent value of'} ${money(premiumCost)} on Opus-tier models. Much routine work (edits, Q&A, refactors) runs fine on Sonnet at ~⅗ the price. Repricing all of it as Sonnet would have been ${money(premiumAsSonnet)} — a ${money(sonnetDelta)} difference; as Haiku, ${money(premiumAsHaiku)}.`,
      estSavings: est,
      estNote: 'est. for routine ~40% of premium work, last 30d',
      currentModel: curModel,
      actions: [
        { kind: 'set-model', model: 'sonnet', label: 'Default to Sonnet 4.6', primary: true, disabled: curModel === 'sonnet' },
        { kind: 'set-model', model: 'haiku', label: 'Default to Haiku (cheapest)', disabled: curModel === 'haiku' },
        restoreModel && restoreModel !== 'sonnet' && restoreModel !== 'haiku'
          ? { kind: 'set-model', model: restoreModel, label: 'Restore ' + prettyModel(restoreModel), subtle: true, disabled: curModel === restoreModel }
          : null,
      ].filter(Boolean),
      footnote: 'Per-session you can still override with /model. Reversible — every change backs up settings.json first.',
    });
  }

  // ---- R2: cache efficiency --------------------------------------------------
  const c = account.composition || emptyUsage();
  const denom = (c.input || 0) + (c.cacheCreation || 0) + (c.cacheRead || 0);
  const cacheEff = denom ? (c.cacheRead || 0) / denom : 0;
  const cacheSaved = (account.cache && account.cache.savings) || 0;
  if (denom > 1_000_000 && cacheEff < 0.6) {
    recs.push({
      id: 'cache-efficiency',
      severity: cacheEff < 0.35 ? 'med' : 'low',
      icon: '♻️',
      title: 'Reuse context with prompt caching',
      metric: `${(cacheEff * 100).toFixed(0)}% of input served from cache`,
      detail: `Cache reads bill at ~0.1× fresh input. You're already saving ${money(cacheSaved)} from caching, but a low hit-rate means sessions are rebuilding context from scratch. Continue a session (↑ / --continue) instead of starting fresh, and let it run rather than restarting — each restart re-pays full input price for the context.`,
      estSavings: null,
      actions: [
        { kind: 'navigate', view: 'account', label: 'See cache breakdown' },
        { kind: 'navigate', view: 'guide', label: 'How caching works', subtle: true },
      ],
    });
  }

  // ---- R2b: context weight — when cache reads ARE the bill -------------------
  // The opposite failure mode from R2: hit-rate is fine, but sessions carry such
  // a large context that re-reading it on every message dominates total spend.
  const ctxShare = totalCost > 0 ? cacheReadCostTotal / totalCost : 0;
  if (cacheReadCostTotal > 20 && ctxShare >= 0.4) {
    ctxHeavy.sort((a, b) => b.crCost - a.crCost);
    const top = ctxHeavy.slice(0, 6);
    const avgCtx = top.length ? top.reduce((a, s) => a + s.ctxPerMsg, 0) / top.length : 0;
    // If heavy sessions had been compacted to ~a 120K working context, their
    // cache-read spend would shrink roughly in proportion.
    const TARGET_CTX = 120_000;
    const reducible = ctxHeavy.reduce((a, s) =>
      a + (s.ctxPerMsg > TARGET_CTX ? s.crCost * (1 - TARGET_CTX / s.ctxPerMsg) : 0), 0);
    recs.push({
      id: 'context-weight',
      severity: ctxShare >= 0.6 ? 'high' : 'med',
      icon: '📚',
      title: 'Re-read context is most of your bill',
      metric: `${Math.round(ctxShare * 100)}% of spend is cache reads (${money(cacheReadCostTotal)})`,
      detail: `Your cache hit-rate is healthy — the cost comes from context SIZE. Every message re-reads the whole session context (billed as cache reads), so a session holding ${fmtNum(avgCtx)} tokens pays for all of them again on every turn. Run /compact when a long session finishes a task, start a fresh session for a new task instead of piling on, and avoid the [1m] long-context mode as a default — past 200K context, even cache reads bill at ~2× premium rates.`,
      estSavings: reducible * monthlyFactor,
      estNote: 'if heavy sessions ran at a ~120K working context, last 30d',
      list: top.map((s) => ({
        session: s.session, project: s.project,
        label: (s.projectName ? s.projectName + ' · ' : '') + (s.title || s.session).slice(0, 60),
        sub: fmtNum(s.ctxPerMsg) + ' tokens re-read per message · ' + s.msgs + ' msgs · ' + money(s.crCost) + ' in cache reads',
        action: { kind: 'open-project', project: s.project, label: 'Open' },
      })),
      actions: [{ kind: 'navigate', view: 'account', label: 'See cache breakdown' }],
      footnote: 'Compaction and fresh sessions shrink what every future message has to re-read — they don\'t refund past spend.',
    });
  }

  // ---- R2c: cache churn — idle gaps expire the cache mid-session -------------
  // Claude Code's prompt cache lives ~5 minutes. Pause longer than that and the
  // next message re-WRITES the whole context at 1.25× input price instead of
  // re-READING it at 0.1× — a 12.5× difference on the same tokens. We flag each
  // message that follows a >5-min gap and carries a big cache write, and price
  // what a warm cache would have cost instead.
  const TTL_MS = 5 * 60 * 1000;
  const CHURN_MIN_TOKENS = 20_000; // ignore small writes — genuinely new content
  let churnCostTotal = 0;
  const churny = []; // per-session churn summaries
  for (const p of projects) {
    for (const s of p.sessions || []) {
      const times = (s.msgTimes || [])
        .filter((m) => m.t > 0 && m.cacheCreation != null)
        .sort((a, b) => a.t - b.t);
      let cold = 0, waste = 0, wasteTok = 0;
      for (let i = 1; i < times.length; i++) {
        const m = times[i];
        if (m.t - times[i - 1].t <= TTL_MS || m.cacheCreation < CHURN_MIN_TOKENS) continue;
        const model = m.model || s.primaryModel;
        // Avoidable spend ≈ (write at 1.25×) − (read at 0.1×) on the same tokens.
        waste += costFor(model, { cacheCreation: m.cacheCreation })
               - costFor(model, { cacheRead: m.cacheCreation });
        wasteTok += m.cacheCreation;
        cold++;
      }
      if (cold > 0) {
        churnCostTotal += waste;
        churny.push({
          session: s.id, project: p.id, projectName: p.name, title: s.title,
          cold, waste, wasteTok,
        });
      }
    }
  }
  if (churnCostTotal > 5) {
    churny.sort((a, b) => b.waste - a.waste);
    const top = churny.slice(0, 6);
    const churnShare = totalCost > 0 ? churnCostTotal / totalCost : 0;
    recs.push({
      id: 'cache-churn',
      severity: churnShare >= 0.25 ? 'high' : 'med',
      icon: '⏱️',
      title: 'Idle gaps are expiring your prompt cache',
      metric: `${money(churnCostTotal)} re-paid in expired-cache rewrites`,
      detail: `Claude Code's prompt cache expires after ~5 minutes of inactivity. When you come back to a session after a longer pause, the next message re-writes the entire context at 1.25× input price instead of re-reading it at 0.1× — the same tokens cost ~12× more. Batch your follow-ups while a session is warm, queue related questions together instead of drip-feeding them, and when you plan to step away, wrap up the task first. Resuming later is fine — just know the first message back re-pays the full context write.`,
      estSavings: churnCostTotal * monthlyFactor,
      estNote: 'if post-gap messages had hit a warm cache, last 30d',
      list: top.map((s) => ({
        session: s.session, project: s.project,
        label: (s.projectName ? s.projectName + ' · ' : '') + (s.title || s.session).slice(0, 60),
        sub: s.cold + ' cold restart' + (s.cold > 1 ? 's' : '') + ' · ' + fmtNum(s.wasteTok)
          + ' tokens re-written · ' + money(s.waste) + ' avoidable',
        action: { kind: 'open-project', project: s.project, label: 'Open' },
      })),
      actions: [{ kind: 'navigate', view: 'account', label: 'See cache breakdown' }],
      footnote: 'Approximate — a post-gap cache write also includes genuinely new content (tool results, files read), so treat the estimate as an upper bound.',
    });
  }

  // ---- R3: budgets / pacing --------------------------------------------------
  if (!budgets.day) {
    const dailyVals = Object.values(account.daily || {}).filter((v) => v > 0);
    const suggested = Math.round((median(dailyVals) * 1.25) / 1000) * 1000 || 200_000;
    recs.push({
      id: 'set-budget',
      severity: 'low',
      icon: '🎯',
      title: 'Set a daily pacing budget',
      metric: 'no budget configured',
      detail: `A token budget turns the Account gauges into a "how much headroom is left" readout — useful for staying under ${metered ? 'your spend target' : 'Max rate limits'}. Based on your recent days, ${fmtNum(suggested)} tokens/day is a sensible starting target.`,
      estSavings: null,
      actions: [
        { kind: 'set-budget', day: suggested, label: `Set ${fmtNum(suggested)}/day budget`, primary: true },
        { kind: 'navigate', view: 'settings', label: 'Pick my own', subtle: true },
      ],
    });
  }

  // ---- R4: end idle / open sessions -----------------------------------------
  // Two kinds of "open" work count here: external CLI / VS Code sessions (their
  // transcript was touched in the last 10 min) and in-dashboard Workbench runs
  // still in flight. The "End all" action below closes both at once.
  const runRows = runs.map((r) => ({
    run: r.runId, project: r.project,
    label: (r.projectName ? r.projectName + ' · ' : '') + 'Workbench run' + (r.session ? ' (resumed)' : ''),
    sub: 'in dashboard · started ' + Math.max(0, Math.round((Date.now() - (r.startedAt || Date.now())) / 60000)) + 'm ago',
    action: { kind: 'end-run', runId: r.runId, label: 'End' },
  }));
  const openCount = live.length + runRows.length;
  if (openCount > 0) {
    live.sort((a, b) => a.mtime - b.mtime); // stalest first
    const sessionRows = live.slice(0, 8).map((s) => ({
      session: s.session, project: s.project,
      label: (s.projectName ? s.projectName + ' · ' : '') + (s.title || s.session).slice(0, 60),
      sub: money(s.cost) + ' · ' + 'active ' + Math.max(0, Math.round((Date.now() - s.mtime) / 60000)) + 'm ago',
      action: { kind: 'end-session', session: s.session, label: 'End' },
    }));
    const mix = live.length && runRows.length ? ` — ${live.length} CLI, ${runRows.length} in dashboard` : '';
    recs.push({
      id: 'idle-sessions',
      severity: openCount >= 3 ? 'med' : 'low',
      icon: '🛑',
      title: `End sessions you're done with (${openCount} open)`,
      metric: `${openCount} session${openCount > 1 ? 's' : ''} active${mix}`,
      detail: metered
        ? 'Open sessions don\'t bill while idle, but a forgotten auto-running session can keep spending. End any you no longer need — or close them all at once below.'
        : 'Closing finished sessions frees up rate-limit headroom in your rolling 5-hour window. End any you no longer need — or close them all at once below.',
      estSavings: null,
      list: [...runRows, ...sessionRows],
      actions: [{ kind: 'end-all', label: `End all active sessions (${openCount})`, primary: true }],
      footnote: 'Closes both Workbench runs and external Claude Code sessions. A terminal/VS Code session can only be ended once it has run a tool (so the dashboard recorded its process).',
    });
  }

  // ---- R5: oversized sessions ------------------------------------------------
  if (heavy.length > 0) {
    heavy.sort((a, b) => b.cost - a.cost);
    const top = heavy.slice(0, 5);
    recs.push({
      id: 'heavy-sessions',
      severity: 'low',
      icon: '🧱',
      title: 'Trim oversized session contexts',
      metric: `${heavy.length} session${heavy.length > 1 ? 's' : ''} over 400K tokens`,
      detail: 'Very long sessions re-send a huge context every turn, so each new message is expensive even when caching helps. For a fresh task, start a new session or run /compact rather than piling onto a giant transcript.',
      estSavings: null,
      list: top.map((s) => ({
        session: s.session, project: s.project,
        label: (s.projectName ? s.projectName + ' · ' : '') + (s.title || s.session).slice(0, 60),
        sub: fmtNum(s.tokens) + ' tokens · ' + money(s.cost),
        action: { kind: 'open-project', project: s.project, label: 'Open' },
      })),
    });
  }

  const order = { high: 0, med: 1, low: 2, info: 3 };
  recs.sort((a, b) => (order[a.severity] - order[b.severity]) || ((b.estSavings || 0) - (a.estSavings || 0)));

  const estMonthlySavings = recs.reduce((s, r) => s + (r.estSavings || 0), 0);

  return {
    generatedAt: Date.now(),
    metered,
    plan: plan || { metered: true },
    totalCost,
    monthCost,
    currentModel: curModel,
    estMonthlySavings,
    recommendations: recs,
  };

  function money(n) { n = n || 0; return '$' + (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(2)); }
  function fmtNum(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(Math.round(n));
  }
}
