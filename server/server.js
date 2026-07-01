import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { listProjects, getProject, readSessionChat } from './sessions.js';
import { githubFor, repoMetrics, detectRepo } from './github.js';
import { approvalsSummary, addRule, removeRule } from './approvals.js';
import { getCustomApps, addApp, removeApp, syntheticProjects, detectStack } from './apps.js';
import { ghStatus, projectsRoot, scaffoldProject } from './scaffold.js';
import { hasUsers, registerUser, verifyLogin, createSession, destroySession, userForToken, createInvite, listInvites, ownerLanIdentity } from './auth.js';
import { startDiscovery, lanPeers, findPeer, selfMid, accountAuthHeader, verifyAccountHeader } from './lan.js';
import { runQuery } from './claude.js';
import { prettyModel, costFor } from './pricing.js';
import { buildRecommendations, setDefaultModel } from './optimize.js';

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

// ---- same-network (LAN) access ---------------------------------------------
// Non-internal IPv4 addresses of this machine — used so phones / tablets / other
// computers on the same Wi-Fi can reach the dashboard when LAN access is on.
function lanIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}
function primaryLanIP() { return lanIPv4s()[0] || null; }
const isPrivateIPv4 = (ip) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

// Opt-in: when data/config.json has "lanAccess": true we bind to the network and
// accept same-network requests (still login-gated). Default OFF — the dashboard
// stays loopback-only until you turn this on in Settings. Read once at startup
// because the listen() bind host can't change without a restart.
const LAN_ACCESS = readConfig().lanAccess === true;
function lanUrl() {
  const ip = primaryLanIP();
  return LAN_ACCESS && ip ? `http://${ip}:${PORT}` : null;
}
// Begin announcing on the LAN + listening for same-account peers. The identity
// (owner's derived key) may not exist yet on first run; the discovery service
// re-checks it each tick and starts advertising once someone has signed in.
function startLanDiscovery() {
  startDiscovery({
    httpPort: PORT,
    getIdentity: () => {
      const id = ownerLanIdentity();
      return id ? { id: id.id, key: id.key, name: os.hostname() } : null;
    },
  });
}

// ---- auth helpers -----------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) { return userForToken(parseCookies(req)['cc_session']); }
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `cc_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'cc_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}
// Endpoints reachable without a session: auth itself, health, and the local
// gateway hook (loopback-only, has no user session of its own).
const AUTH_EXEMPT = new Set([
  '/api/auth/status', '/api/auth/login', '/api/auth/register', '/api/auth/logout',
  '/api/health', '/api/approval-request', '/api/approval-poll',
]);

// Loopback-only shared secret: the broker bridge forwards already-authenticated
// remote requests to this agent with this header, bypassing the local login gate
// (the broker is the auth authority for remote access).
const INTERNAL_TOKEN_FILE = path.join(DATA_DIR, 'internal-token');
function loadInternalToken() {
  try { const t = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch { /* create below */ }
  const t = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(INTERNAL_TOKEN_FILE, t); } catch { /* non-fatal */ }
  return t;
}
const INTERNAL_TOKEN = loadInternalToken();

// ---- approval gateway state -------------------------------------------------
// In-memory queue of tool calls awaiting a dashboard decision. The blocking
// PreToolUse hook (hooks/gateway.mjs) creates entries and polls for the verdict;
// the dashboard sets it. Lives in this process so hook ↔ dashboard share it.
const pending = new Map(); // id -> { id, tool, input, cwd, project, session, ts, status, reason }
let approvalSeq = 1;

// Active dashboard-spawned Claude runs, so a session can be ended from anywhere
// (its own pane, another tab, or the application page) — not just by closing the
// pane that started it. id -> { child, project, projectName, session, startedAt }.
const activeRuns = new Map();
let runSeq = 1;
function stopRuns(match) {
  let killed = 0;
  for (const [id, r] of activeRuns) {
    if (match(id, r)) {
      try { if (r.child && !r.child.killed) r.child.kill(); } catch { /* */ }
      activeRuns.delete(id); killed++;
    }
  }
  return killed;
}

// ---- ending EXTERNAL sessions (VS Code / terminal) --------------------------
// The logger hook resolves + caches each session's claude.exe PID (data/
// session-pids.json). To end one, verify that PID is still a claude process
// (guards against PID reuse) and kill its tree.
function sessionPid(sessionId) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'session-pids.json'), 'utf8'));
    const e = m[sessionId];
    if (e && e.pid) return e;
  } catch { /* no cache yet */ }
  return null;
}
function processName(pid) {
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  }
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){ $p.Name }`],
    { encoding: 'utf8', windowsHide: true, timeout: 6000 });
  return (r.stdout || '').trim();
}
function killSessionPid(pid) {
  if (!/claude/i.test(processName(pid))) return { ok: false, error: 'That session is no longer running (its process ended).' };
  const k = process.platform === 'win32'
    ? spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true })
    : spawnSync('kill', ['-TERM', String(pid)], { encoding: 'utf8' });
  return { ok: k.status === 0, pid, output: (k.stdout || k.stderr || '').trim() };
}

function readGateway() {
  const g = readConfig().gateway || {};
  return { enabled: !!g.enabled, autoAll: !!g.autoAll, projects: g.projects || {}, projectMode: g.projectMode || {} };
}
function writeGateway(g) {
  const cfg = readConfig();
  cfg.gateway = g;
  writeConfig(cfg);
}
// Windows reports drive-letter case + trailing slashes inconsistently, so match
// workspace paths case/slash-insensitively (otherwise an "auto" workspace can
// silently fall back to manual and the approval is missed).
function normPath(p) { return String(p || '').toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, ''); }
function lookupByPath(map, cwd) {
  const key = normPath(cwd);
  for (const [k, v] of Object.entries(map || {})) if (normPath(k) === key) return v;
  return undefined;
}
function gatewayActiveFor(cwd) {
  const g = readGateway();
  if (!g.enabled) return false;
  if (cwd && lookupByPath(g.projects, cwd) === false) return false; // per-app opt-out
  return true;
}
// 'manual' = ask on the dashboard; 'auto' = always allow (this app, or all apps).
function gatewayModeFor(cwd) {
  const g = readGateway();
  if (g.autoAll) return 'auto';
  return lookupByPath(g.projectMode, cwd) || 'manual';
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
  const modelCacheRead = {}; // model -> cache-read tokens, for cache-savings math
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
      for (const [m, info] of Object.entries(s.models || {})) {
        modelCacheRead[m] = (modelCacheRead[m] || 0) + ((info.usage && info.usage.cacheRead) || 0);
      }
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

  // Cache savings: cache reads bill at 0.1x input, so the discount is the gap
  // between charging those tokens as fresh input vs. as cache reads (per model).
  let cacheSavings = 0, cacheActual = 0;
  for (const [m, crTok] of Object.entries(modelCacheRead)) {
    if (!crTok) continue;
    cacheSavings += costFor(m, { input: crTok }) - costFor(m, { cacheRead: crTok });
    cacheActual += costFor(m, { cacheRead: crTok });
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
    cache: { savings: cacheSavings, actual: cacheActual, readTokens: comp.cacheRead },
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
  // ---- auth ----
  if (pathname === '/api/auth/status') {
    return sendJson(res, 200, {
      hasUsers: hasUsers(), user: currentUser(req),
      publicUrl: readConfig().publicUrl || null,
      lan: { active: LAN_ACCESS, ip: primaryLanIP(), port: PORT, url: lanUrl(), hasIdentity: !!ownerLanIdentity() },
    });
  }
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readBody(req);
    const r = registerUser(body.email, body.password, body.invite); // first owner free; others need an invite
    if (!r.ok) return sendJson(res, 400, r);
    setSessionCookie(res, createSession(r.user.id));
    return sendJson(res, 200, { ok: true, user: r.user });
  }
  // mint / list invite codes (signed-in users only — gated by the block below)
  if (pathname === '/api/auth/invite') {
    if (req.method === 'POST') return sendJson(res, 200, { ok: true, code: createInvite((currentUser(req) || {}).id) });
    return sendJson(res, 200, { invites: listInvites() });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const u = verifyLogin(body.email, body.password);
    if (!u) return sendJson(res, 401, { error: 'Wrong email or password.' });
    setSessionCookie(res, createSession(u.id));
    return sendJson(res, 200, { ok: true, user: u });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    destroySession(parseCookies(req)['cc_session']);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/overview') {
    return sendJson(res, 200, overviewPayload(mergedProjects()));
  }

  // Same-account machines on this LAN (auto-discovered). Only when LAN access is
  // on — otherwise we behave like before (404 → frontend treats it as single,
  // local-only). The broker has its own /api/machines for remote multi-machine.
  if (pathname === '/api/machines' && req.method === 'GET') {
    if (!LAN_ACCESS) return sendJson(res, 404, { error: 'unknown endpoint' });
    const machines = [
      { agentId: selfMid(), name: os.hostname() + ' · this computer', connected: true, self: true },
      ...lanPeers().map((p) => ({ agentId: p.mid, name: p.name, connected: true, lan: true })),
    ];
    return sendJson(res, 200, { ok: true, mode: 'lan', machines });
  }

  if (pathname === '/api/account') {
    return sendJson(res, 200, accountPayload());
  }

  // Cost-saving recommendations derived from the local transcripts.
  if (pathname === '/api/recommendations') {
    const cfg = readConfig();
    return sendJson(res, 200, buildRecommendations({
      projects: listProjects(),
      account: accountPayload(),
      plan: readPlan(),
      budgets: cfg.budgets || {},
      runs: [...activeRuns.entries()].map(([id, r]) => ({ runId: id, project: r.project, projectName: r.projectName, session: r.session, startedAt: r.startedAt })),
    }));
  }

  // Apply a recommendation's action (currently: set the default model).
  if (pathname === '/api/optimize' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'set-model') return sendJson(res, 200, setDefaultModel(body.model));
    return sendJson(res, 400, { error: 'unknown action' });
  }

  // Compact per-machine app list for the Fleet view: each app with its GitHub
  // repo + detected stack/platforms, so the dashboard can group the same app
  // across computers and offer the right (iOS / Android) build action. Fast by
  // design (cached git detection) so it survives the broker's proxy timeout.
  if (pathname === '/api/fleet-apps') {
    const apps = await Promise.all(mergedProjects().map(async (p) => {
      let github = p.githubOverride || null;
      if (!github && p.cwd) { const r = await detectRepo(p.cwd); if (r) github = `${r.owner}/${r.repo}`; }
      const stack = p.cwd ? detectStack(p.cwd) : null;
      return {
        id: p.id, name: p.name, cwd: p.cwd, github,
        stack: stack ? stack.stack : null, stackLabel: stack ? stack.label : null,
        ios: stack ? stack.ios : false, android: stack ? stack.android : false,
        liveCount: p.liveCount, sessionCount: p.sessionCount, cost: p.cost, lastActivity: p.lastActivity,
      };
    }));
    return sendJson(res, 200, { os: process.platform, host: os.hostname(), apps });
  }

  if (pathname === '/api/session') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const chat = readSessionChat(q.get('project'), q.get('id'));
    if (!chat) return sendJson(res, 404, { error: 'session not found' });
    return sendJson(res, 200, { messages: chat });
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'vibecenter', version: VERSION, uptimeSec: Math.round(process.uptime()), build: assetBuild() });
  }

  // Restart the agent so server-code updates take effect. A detached helper
  // waits for this process to release the port, then starts a fresh server.
  if (pathname === '/api/restart' && req.method === 'POST') {
    sendJson(res, 200, { ok: true });
    try {
      const restarter = path.join(ROOT, 'vibecenter', 'restart.mjs');
      spawn(process.execPath, [restarter], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
    } catch { /* */ }
    setTimeout(() => process.exit(0), 350); // let the response flush, then free the port
    return;
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

  // Lightweight pending-approvals feed — polled globally so the in-app prompt
  // can pop up on any screen, not just the Approvals tab.
  if (pathname === '/api/pending') {
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.ts > 5 * 60 * 1000) pending.delete(id);
    // Include the gateway flags so the client can relax its poll rate when
    // nothing can ever go pending (gateway off, or always-allow-all on).
    const g = readGateway();
    return sendJson(res, 200, {
      pending: [...pending.values()].filter((p) => p.status === 'pending').sort((a, b) => a.ts - b.ts),
      gateway: { enabled: g.enabled, autoAll: g.autoAll },
    });
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
      if (typeof body.lanAccess === 'boolean') cfg.lanAccess = body.lanAccess;
      if (typeof body.publicUrl === 'string') {
        const u = body.publicUrl.trim().replace(/\/+$/, '');
        if (u) cfg.publicUrl = u; else delete cfg.publicUrl;
      }
      writeConfig(cfg);
      return sendJson(res, 200, { ok: true, hasToken: !!githubToken(), budgets: cfg.budgets || {}, lanAccess: cfg.lanAccess === true, publicUrl: cfg.publicUrl || null });
    }
    return sendJson(res, 200, {
      hasToken: !!githubToken(), plan: readPlan(), budgets: readConfig().budgets || {},
      lanAccess: readConfig().lanAccess === true, lanActive: LAN_ACCESS,
      lanIp: primaryLanIP(), port: PORT, publicUrl: readConfig().publicUrl || null,
    });
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
    return streamQuery(res, req, cwd, String(body.prompt).trim(), body.model, body.session, body.write ? 'default' : 'plan',
      { project: proj.id, projectName: proj.name });
  }

  // List active dashboard runs (optionally filtered to one application).
  if (pathname === '/api/active') {
    const proj = new URL(req.url, 'http://localhost').searchParams.get('project');
    const runs = [...activeRuns.entries()]
      .filter(([, r]) => !proj || r.project === proj)
      .map(([id, r]) => ({ runId: id, project: r.project, projectName: r.projectName, session: r.session, startedAt: r.startedAt }));
    return sendJson(res, 200, { runs });
  }

  // End a running session by runId, or every run for an application.
  if (pathname === '/api/stop' && req.method === 'POST') {
    const body = await readBody(req);
    const killed = stopRuns((id, r) =>
      (body.runId && id === body.runId) || (body.project && r.project === body.project));
    return sendJson(res, 200, { ok: true, killed });
  }

  // End EVERYTHING active in one shot: all in-dashboard Workbench runs plus
  // every external (VS Code / terminal) session whose process we have on record.
  // External sessions without a recorded PID are reported as `noPid` (they can't
  // be ended remotely until they've run a tool once).
  if (pathname === '/api/stop-all' && req.method === 'POST') {
    const killedRuns = stopRuns(() => true);
    let killedExternal = 0, noPid = 0;
    for (const p of listProjects()) {
      for (const s of p.sessions) {
        if (!s.active) continue;
        const info = sessionPid(s.id);
        if (!info) { noPid++; continue; }
        if (killSessionPid(info.pid).ok) killedExternal++;
      }
    }
    return sendJson(res, 200, { ok: true, killedRuns, killedExternal, noPid });
  }

  // End an EXTERNAL (VS Code / terminal) session by killing its claude process.
  if (pathname === '/api/stop-session' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.session) return sendJson(res, 400, { error: 'session required' });
    const info = sessionPid(body.session);
    if (!info) return sendJson(res, 404, { error: 'No recorded process for this session yet — it needs to run a tool once (so the hook can capture it) before it can be ended from here.' });
    const result = killSessionPid(info.pid);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  // ---- approval gateway ----
  if (pathname === '/api/gateway') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const g = readGateway();
      if (typeof body.enabled === 'boolean') g.enabled = body.enabled;
      if (typeof body.autoAll === 'boolean') g.autoAll = body.autoAll;
      if (body.project && typeof body.projectEnabled === 'boolean') {
        for (const k of Object.keys(g.projects)) if (normPath(k) === normPath(body.project)) delete g.projects[k];
        g.projects[normPath(body.project)] = body.projectEnabled;
      }
      if (body.project && (body.mode === 'manual' || body.mode === 'auto')) {
        for (const k of Object.keys(g.projectMode)) if (normPath(k) === normPath(body.project)) delete g.projectMode[k];
        g.projectMode[normPath(body.project)] = body.mode;
      }
      writeGateway(g);
      return sendJson(res, 200, g);
    }
    return sendJson(res, 200, readGateway());
  }

  // hook → register a tool call awaiting approval; returns id (or active:false)
  if (pathname === '/api/approval-request' && req.method === 'POST') {
    const body = await readBody(req);
    if (!gatewayActiveFor(body.cwd)) return sendJson(res, 200, { active: false });
    // Always-allow (this workspace or globally) → tell the hook to approve now.
    if (gatewayModeFor(body.cwd) === 'auto') return sendJson(res, 200, { active: true, decision: 'allow' });
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

// Relay an API request to a linked LAN peer's agent, authenticated with our
// shared account key. The browser only ever talks to this (local) agent; we act
// as the trusted proxy to same-account machines on the network.
function proxyToPeer(req, res, peer) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let target; try { target = new URL(req.url, peer.url); } catch { return sendJson(res, 502, { error: 'bad peer url' }); }
    const headers = { 'X-CC-Account': accountAuthHeader() || '' };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (body.length) headers['content-length'] = body.length;
    const preq = http.request(target, { method: req.method, headers }, (pres) => {
      res.writeHead(pres.statusCode || 502, { 'Content-Type': pres.headers['content-type'] || 'application/json' });
      pres.pipe(res);
    });
    preq.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'peer unreachable' }); });
    preq.setTimeout(30000, () => { try { preq.destroy(); } catch { /* */ } });
    if (body.length) preq.write(body);
    preq.end();
  });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'request error' }); });
}

// Stream a headless Claude query back as newline-delimited JSON events.
function streamQuery(res, req, cwd, prompt, model, resumeId, permissionMode, meta = {}) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (ev) => { try { res.write(JSON.stringify(ev) + '\n'); } catch { /* client gone */ } };
  const runId = 'run-' + (runSeq++);
  const child = runQuery({ cwd, prompt, model, resumeId, permissionMode }, (ev) => {
    send(ev);
    if (ev.type === 'done') { activeRuns.delete(runId); try { res.end(); } catch { /* */ } }
  });
  if (child) {
    activeRuns.set(runId, { child, project: meta.project || null, projectName: meta.projectName || null, session: resumeId || null, startedAt: Date.now() });
    send({ type: 'run', runId }); // let the client stop this exact run by id
  }
  req.on('close', () => { activeRuns.delete(runId); if (child && !child.killed) { try { child.kill(); } catch { /* */ } } });
}

// Newest mtime of the app shell — bumps whenever the UI is edited, so the
// desktop window can detect an update and reload itself.
// Newest mtime across the UI AND server/hook code, so the desktop window can
// detect ANY update (a page reload covers web changes; a restart covers server).
function assetBuild() {
  let m = 0;
  const add = (f) => { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch { /* missing */ } };
  for (const f of ['app.js', 'styles.css', 'index.html']) add(path.join(WEB_DIR, f));
  for (const dir of [path.join(ROOT, 'server'), path.join(ROOT, 'hooks')]) {
    try { for (const f of fs.readdirSync(dir)) if (/\.m?js$/.test(f)) add(path.join(dir, f)); } catch { /* */ }
  }
  return Math.round(m);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Never cache app shell/assets, so the local desktop window always shows
      // the latest UI without a manual hard-reload.
      'Cache-Control': 'no-store, must-revalidate',
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
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
// With LAN access on we additionally accept our own private-network address on
// the right port — that's the whole point (serving same-Wi-Fi devices) — but
// nothing else, so DNS-rebinding from a public name is still blocked.
function hostOk(host) {
  if (ALLOWED_HOSTS.has(host)) return true;
  if (!LAN_ACCESS) return false;
  const m = host.match(/^([0-9.]+):(\d+)$/);
  return !!m && m[2] === String(PORT) && isPrivateIPv4(m[1]);
}
function securityReject(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!hostOk(host)) return 'host';
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { return 'origin'; }
    const okHost = LOOPBACK_HOSTS.includes(o.hostname) || (LAN_ACCESS && isPrivateIPv4(o.hostname));
    if (!okHost || o.port !== String(PORT)) return 'origin';
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (securityReject(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden'); }
  try {
    if (pathname.startsWith('/api/')) {
      // Once an owner account exists, every data/control endpoint needs a valid
      // session — OR a valid same-account peer HMAC (a linked LAN machine relaying
      // on your behalf), OR the loopback internal token (the broker bridge / hooks).
      if (hasUsers() && !AUTH_EXEMPT.has(pathname) && !currentUser(req)
          && req.headers['x-cc-internal'] !== INTERNAL_TOKEN
          && !verifyAccountHeader(req.headers['x-cc-account'])) {
        return sendJson(res, 401, { error: 'Sign in required.' });
      }
      // Viewing a linked LAN peer: relay this request to that machine's agent
      // (authenticated with our shared account key). Never relay the machine
      // list or auth — those are answered locally.
      const peerMid = req.headers['x-cc-machine'];
      if (peerMid && peerMid !== selfMid() && pathname !== '/api/machines' && !pathname.startsWith('/api/auth/')) {
        const peer = findPeer(peerMid);
        if (peer) return proxyToPeer(req, res, peer);
      }
      return await handleApi(req, res, pathname);
    }
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

// Loopback only by default. When LAN access is opted-in (Settings → Network),
// bind to all interfaces so same-network devices can reach the (login-gated)
// dashboard — and start same-account peer discovery on the local network.
const BIND_HOST = LAN_ACCESS ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  console.log(`\n  ⚡ Vibe Center running`);
  console.log(`  → http://localhost:${PORT}`);
  if (lanUrl()) console.log(`  → ${lanUrl()}  (same-network devices)`);
  console.log(`\n  GitHub token: ${githubToken() ? 'configured' : 'not set (add in Settings)'}\n`);
  if (LAN_ACCESS) startLanDiscovery();
});
