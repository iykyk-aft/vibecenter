import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { listProjects, getProject, readSessionChat } from './sessions.js';
import { githubFor, repoMetrics } from './github.js';
import { approvalsSummary, addRule, removeRule } from './approvals.js';
import { getCustomApps, addApp, removeApp, syntheticProjects } from './apps.js';
import { ghStatus, projectsRoot, scaffoldProject } from './scaffold.js';
import { runQuery } from './claude.js';
import { prettyModel } from './pricing.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = process.env.PORT || 7878;
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

fs.mkdirSync(DATA_DIR, { recursive: true });

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function githubToken() {
  return process.env.GITHUB_TOKEN || readConfig().githubToken || null;
}

// ---- approval gateway state -------------------------------------------------
// In-memory queue of tool calls awaiting a dashboard decision. The blocking
// PreToolUse hook (hooks/gateway.mjs) creates entries and polls for the verdict;
// the dashboard sets it. Lives in this process so hook ↔ dashboard share it.
const pending = new Map(); // id -> { id, tool, input, cwd, project, session, ts, status, reason }
let approvalSeq = 1;

function readGateway() {
  const g = readConfig().gateway || {};
  return { enabled: !!g.enabled, projects: g.projects || {} };
}
function writeGateway(g) {
  const cfg = readConfig();
  cfg.gateway = g;
  writeConfig(cfg);
}
function gatewayActiveFor(cwd) {
  const g = readGateway();
  if (!g.enabled) return false;
  if (cwd && g.projects && g.projects[cwd] === false) return false; // per-app opt-out
  return true;
}

// Read ONLY the non-secret plan fields from credentials (never tokens) so the
// dashboard can label cost correctly: a subscription plan is a flat fee, so the
// computed "cost" is the API-equivalent token value, not money charged.
function readPlan() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const c = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const o = c.claudeAiOauth || {};
    if (o.subscriptionType) {
      return { type: o.subscriptionType, tier: o.rateLimitTier || null, metered: false };
    }
  } catch { /* no credentials / API-key user */ }
  return { type: 'api', tier: null, metered: true };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

// ---- aggregate builders ----------------------------------------------------

function overviewPayload(projects) {
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  let cost = 0, billableTokens = 0, sessions = 0, live = 0, toolCalls = 0;
  const modelTokens = {};
  const daily = {};
  const modelDaily = {}; // 'YYYY-MM-DD' -> { model: tokens }
  for (const p of projects) {
    totals.input += p.tokens.input;
    totals.output += p.tokens.output;
    totals.cacheCreation += p.tokens.cacheCreation;
    totals.cacheRead += p.tokens.cacheRead;
    cost += p.cost;
    billableTokens += p.billableTokens;
    sessions += p.sessionCount;
    live += p.liveCount;
    toolCalls += p.toolCalls;
    for (const [m, t] of Object.entries(p.modelTokens)) modelTokens[m] = (modelTokens[m] || 0) + t;
    for (const [d, t] of Object.entries(p.daily)) daily[d] = (daily[d] || 0) + t;
    for (const [d, mm] of Object.entries(p.dailyModel || {})) {
      if (!modelDaily[d]) modelDaily[d] = {};
      for (const [m, t] of Object.entries(mm)) modelDaily[d][m] = (modelDaily[d][m] || 0) + t;
    }
  }
  return {
    generatedAt: Date.now(),
    plan: readPlan(),
    totals: { cost, billableTokens, sessions, live, toolCalls, tokens: totals },
    models: Object.entries(modelTokens)
      .filter(([, tokens]) => tokens > 0)
      .map(([model, tokens]) => ({ model, label: prettyModel(model), tokens }))
      .sort((a, b) => b.tokens - a.tokens),
    daily,
    modelDaily,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      cwd: p.cwd,
      cost: p.cost,
      billableTokens: p.billableTokens,
      sessionCount: p.sessionCount,
      liveCount: p.liveCount,
      toolCalls: p.toolCalls,
      lastActivity: p.lastActivity,
      modelTokens: p.modelTokens,
      daily: p.daily,
    })),
  };
}

// ---- routes ----------------------------------------------------------------

function mergedProjects() {
  const disc = listProjects();
  return [...disc, ...syntheticProjects(disc)];
}

function isoDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function currentStreak(activeDays) {
  let streak = 0;
  const d = new Date();
  if (!activeDays.has(isoDay(d))) d.setDate(d.getDate() - 1); // allow today or yesterday as anchor
  while (activeDays.has(isoDay(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

// Account-wide metrics derived entirely from local transcripts.
function accountPayload() {
  const projects = listProjects();
  const now = Date.now();
  const HOUR = 3600e3, DAY = 86400e3;
  let allTok = 0, allCost = 0, sessions = 0, tools = 0;
  const toolAgg = {};
  const hourly = new Array(24).fill(0);
  const dow = new Array(7).fill(0);
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0)); // [day][hour] tokens
  const comp = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }; // token composition
  const dailyTok = {}, dailyCost = {};
  const sessionSizes = []; // billable tokens per session, for the distribution histogram
  const activeDays = new Set();
  let win5Tok = 0, win5Msgs = 0, firstTs = Infinity;
  const range = { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 }, month: { tokens: 0, cost: 0 } };
  const allMsgs = [];

  for (const p of projects) {
    sessions += p.sessionCount;
    tools += p.toolCalls;
    comp.input += p.tokens.input; comp.output += p.tokens.output;
    comp.cacheCreation += p.tokens.cacheCreation; comp.cacheRead += p.tokens.cacheRead;
    for (const s of p.sessions) {
      if (s.billableTokens > 0) sessionSizes.push(s.billableTokens);
      for (const [name, c] of Object.entries(s.toolBreakdown || {})) toolAgg[name] = (toolAgg[name] || 0) + c;
      for (const m of s.msgTimes || []) {
        allTok += m.tok; allCost += m.cost;
        if (!m.t) continue;
        allMsgs.push(m);
        const d = new Date(m.t);
        hourly[d.getHours()] += m.tok;
        dow[d.getDay()] += m.tok;
        heat[d.getDay()][d.getHours()] += m.tok;
        const dk = isoDay(d);
        dailyTok[dk] = (dailyTok[dk] || 0) + m.tok;
        dailyCost[dk] = (dailyCost[dk] || 0) + m.cost;
        activeDays.add(dk);
        if (m.t < firstTs) firstTs = m.t;
        const age = now - m.t;
        if (age <= 5 * HOUR) { win5Tok += m.tok; win5Msgs++; }
        if (age <= DAY) { range.today.tokens += m.tok; range.today.cost += m.cost; }
        if (age <= 7 * DAY) { range.week.tokens += m.tok; range.week.cost += m.cost; }
        if (age <= 30 * DAY) { range.month.tokens += m.tok; range.month.cost += m.cost; }
      }
    }
  }

  // peak 5-hour rolling window (two-pointer over time-sorted messages)
  allMsgs.sort((a, b) => a.t - b.t);
  let peak5 = 0, lo = 0, run = 0;
  for (let hi = 0; hi < allMsgs.length; hi++) {
    run += allMsgs[hi].tok;
    while (allMsgs[hi].t - allMsgs[lo].t > 5 * HOUR) { run -= allMsgs[lo].tok; lo++; }
    if (run > peak5) peak5 = run;
  }

  const sum = (...names) => names.reduce((a, n) => a + (toolAgg[n] || 0), 0);
  return {
    generatedAt: now,
    plan: readPlan(),
    totals: { tokens: allTok, cost: allCost, sessions, tools, activeDays: activeDays.size, firstTs: firstTs === Infinity ? null : firstTs },
    window5h: { tokens: win5Tok, messages: win5Msgs, peak: peak5 },
    ranges: range,
    budgets: readConfig().budgets || {},
    hourly, dow, heatmap: heat,
    composition: comp,
    daily: dailyTok, dailyCost,
    sessionSizes,
    tools: Object.entries(toolAgg).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    derived: {
      edits: sum('Edit', 'Write', 'MultiEdit', 'NotebookEdit'),
      commands: sum('Bash'),
      reads: sum('Read'),
      searches: sum('WebSearch', 'WebFetch', 'Grep', 'Glob'),
    },
    streak: currentStreak(activeDays),
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/overview') {
    return sendJson(res, 200, overviewPayload(mergedProjects()));
  }

  if (pathname === '/api/account') {
    return sendJson(res, 200, accountPayload());
  }

  if (pathname === '/api/session') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const chat = readSessionChat(q.get('project'), q.get('id'));
    if (!chat) return sendJson(res, 404, { error: 'session not found' });
    return sendJson(res, 200, { messages: chat });
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'vibecenter', version: VERSION, uptimeSec: Math.round(process.uptime()) });
  }

  if (pathname.startsWith('/api/project/')) {
    const id = decodeURIComponent(pathname.slice('/api/project/'.length));
    const p = mergedProjects().find((x) => x.id === id);
    if (!p) return sendJson(res, 404, { error: 'not found' });
    let gh = await githubFor(p.cwd, githubToken());
    // Custom app with an explicit GitHub repo but no detected remote.
    if ((!gh.repo) && p.githubOverride) {
      const [owner, repo] = p.githubOverride.split('/');
      gh = { repo: { owner, repo }, local: gh.local, metrics: await repoMetrics(owner, repo, githubToken()) };
    }
    return sendJson(res, 200, {
      ...p,
      github: gh,
      sessions: p.sessions.map((s) => ({
        id: s.id, title: s.title, active: s.active,
        startTime: s.startTime, endTime: s.endTime, mtime: s.mtime,
        userMessages: s.userMessages, assistantMessages: s.assistantMessages,
        toolCalls: s.toolCalls, cost: s.cost, billableTokens: s.billableTokens,
        tokens: s.tokens, primaryModel: s.primaryModel, gitBranch: s.gitBranch,
      })),
    });
  }

  if (pathname === '/api/approvals') {
    // expire stale pending (>5 min) so a closed session doesn't linger
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.ts > 5 * 60 * 1000) pending.delete(id);
    const summary = approvalsSummary();
    summary.gateway = readGateway();
    summary.pending = [...pending.values()].filter((p) => p.status === 'pending').sort((a, b) => a.ts - b.ts);
    return sendJson(res, 200, summary);
  }

  if (pathname === '/api/allowlist' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'add' && body.rule) return sendJson(res, 200, addRule(body.rule));
    if (body.action === 'remove' && body.rule) return sendJson(res, 200, removeRule(body.rule));
    return sendJson(res, 400, { error: 'bad request' });
  }

  if (pathname === '/api/config') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readConfig();
      if (typeof body.githubToken === 'string') cfg.githubToken = body.githubToken.trim();
      if (body.budgets && typeof body.budgets === 'object') {
        cfg.budgets = cfg.budgets || {};
        for (const k of ['day', 'window5h']) {
          if (k in body.budgets) {
            const n = Number(body.budgets[k]);
            cfg.budgets[k] = Number.isFinite(n) && n > 0 ? n : null;
          }
        }
      }
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true, hasToken: !!githubToken(), budgets: cfg.budgets || {} });
    }
    return sendJson(res, 200, { hasToken: !!githubToken(), plan: readPlan(), budgets: readConfig().budgets || {} });
  }

  if (pathname === '/api/apps') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'add') return sendJson(res, 200, addApp(body));
      if (body.action === 'remove' && body.id) return sendJson(res, 200, removeApp(body.id));
      return sendJson(res, 400, { error: 'bad request' });
    }
    return sendJson(res, 200, { apps: getCustomApps() });
  }

  // GitHub CLI install/auth state — drives what the "create repo" option can do.
  if (pathname === '/api/gh-status') {
    return sendJson(res, 200, { ...ghStatus(), projectsRoot: projectsRoot(readConfig()) });
  }

  // Create a new project folder (+ optional GitHub repo) and register it as an app.
  if (pathname === '/api/scaffold' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) return sendJson(res, 400, { error: 'Give the project a name.' });
    const result = scaffoldProject({
      name: String(body.name).trim(),
      root: projectsRoot(readConfig()),
      createRepo: !!body.createRepo,
      visibility: body.visibility === 'public' ? 'public' : 'private',
    });
    if (!result.ok) return sendJson(res, 400, result);
    const reg = addApp({
      name: String(body.name).trim(),
      path: result.path,
      github: result.github ? `https://github.com/${result.github}` : null,
    });
    return sendJson(res, 200, { ...result, projectId: reg.id, registered: reg.ok });
  }

  if (pathname === '/api/query' && req.method === 'POST') {
    const body = await readBody(req);
    // Only ever run in a folder we already track — never an arbitrary path.
    const proj = mergedProjects().find((x) => x.id === body.project);
    const cwd = proj && proj.cwd;
    if (!cwd) return sendJson(res, 400, { error: 'This application has no local folder to query.' });
    if (!body.prompt || !String(body.prompt).trim()) return sendJson(res, 400, { error: 'empty prompt' });
    // write:true → 'default' mode (can edit/run, gated by the approvals hook).
    return streamQuery(res, req, cwd, String(body.prompt).trim(), body.model, body.session, body.write ? 'default' : 'plan');
  }

  // ---- approval gateway ----
  if (pathname === '/api/gateway') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const g = readGateway();
      if (typeof body.enabled === 'boolean') g.enabled = body.enabled;
      if (body.project && typeof body.projectEnabled === 'boolean') g.projects[body.project] = body.projectEnabled;
      writeGateway(g);
      return sendJson(res, 200, g);
    }
    return sendJson(res, 200, readGateway());
  }

  // hook → register a tool call awaiting approval; returns id (or active:false)
  if (pathname === '/api/approval-request' && req.method === 'POST') {
    const body = await readBody(req);
    if (!gatewayActiveFor(body.cwd)) return sendJson(res, 200, { active: false });
    const id = 'ap-' + (approvalSeq++);
    pending.set(id, {
      id, tool: body.tool || null, input: body.input || null,
      cwd: body.cwd || null, project: body.project || null,
      session: body.session || null, ts: Date.now(), status: 'pending', reason: null,
    });
    return sendJson(res, 200, { active: true, id });
  }

  // hook → poll for the verdict
  if (pathname === '/api/approval-poll') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const p = pending.get(id);
    if (!p) return sendJson(res, 200, { status: 'gone' });
    const status = p.status;
    if (status !== 'pending') pending.delete(id); // consumed once read
    return sendJson(res, 200, { status, reason: p.reason });
  }

  // dashboard → set a decision
  if (pathname === '/api/approval-decide' && req.method === 'POST') {
    const body = await readBody(req);
    const p = pending.get(body.id);
    if (!p) return sendJson(res, 404, { error: 'expired' });
    p.status = body.decision === 'deny' ? 'deny' : 'allow';
    p.reason = body.reason || null;
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

// Stream a headless Claude query back as newline-delimited JSON events.
function streamQuery(res, req, cwd, prompt, model, resumeId, permissionMode) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (ev) => { try { res.write(JSON.stringify(ev) + '\n'); } catch { /* client gone */ } };
  const child = runQuery({ cwd, prompt, model, resumeId, permissionMode }, (ev) => {
    send(ev);
    if (ev.type === 'done') { try { res.end(); } catch { /* */ } }
  });
  req.on('close', () => { if (child && !child.killed) { try { child.kill(); } catch { /* */ } } });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  });
}

// Reject anything that isn't a genuine same-machine request:
//  • Host must be a loopback host  → blocks DNS-rebinding attacks
//  • if an Origin is present it must be our own loopback origin → blocks a
//    malicious website in your browser from POSTing to the API (CSRF).
// Local tools (curl, the hook) send no Origin and are allowed.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function securityReject(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return 'host';
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return 'origin'; }
    const okHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(o.hostname);
    if (!okHost || o.port !== String(PORT)) return 'origin';
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (securityReject(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden'); }
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Vibe Center already running on ${PORT} — reusing it.`);
    process.exit(0);
  }
  throw e;
});

// Bind to loopback only — never expose the dashboard (or the query/approval
// endpoints) to the local network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ⚡ Vibe Center running`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  GitHub token: ${githubToken() ? 'configured' : 'not set (add in Settings)'}\n`);
});
