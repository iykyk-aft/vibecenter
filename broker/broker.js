// Vibe Center broker — the always-on cloud service (deploy on your VPS).
// Owns accounts + invites + sessions, serves the website, and reverse-proxies
// each logged-in user to THEIR OWN machine's agent over an outbound SSE channel
// (so users never port-forward). Data + Claude stay on each user's machine.
//
//   BROKER_PORT=7900 BROKER_DATA=./broker/data node broker/broker.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.BROKER_DATA || path.join(ROOT, 'broker', 'data');
const PORT = process.env.BROKER_PORT || 7900;
fs.mkdirSync(DATA_DIR, { recursive: true });

// Keep the broker's accounts separate from any local agent's, then load auth.
process.env.CC_AUTH_FILE = process.env.CC_AUTH_FILE || path.join(DATA_DIR, 'auth.json');
const { hasUsers, registerUser, verifyLogin, createSession, destroySession, userForToken, createInvite, listInvites } = await import('../server/auth.js');

const PAIR_FILE = path.join(DATA_DIR, 'pairings.json');
const readPairings = () => { try { return JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8')); } catch { return {}; } };
const writePairings = (p) => fs.writeFileSync(PAIR_FILE, JSON.stringify(p, null, 2));

// A pairing record ties one token to one machine on one account:
//   token -> { userId, agentId, name, createdAt }
// Legacy pairings stored a bare userId string (one machine per account); those
// are normalized on read so the old token keeps working as that user's machine.
const asRecord = (token, v) => (typeof v === 'string'
  ? { token, userId: v, agentId: v, name: 'My machine', createdAt: null }
  : { token, ...v });
function pairingFor(token) { const v = readPairings()[token]; return v ? asRecord(token, v) : null; }
function pairingsForUser(userId) {
  return Object.entries(readPairings()).map(([t, v]) => asRecord(t, v)).filter((r) => r.userId === userId);
}
function mintMachine(userId, name) {
  const p = readPairings();
  const token = crypto.randomBytes(24).toString('hex');
  const agentId = 'm_' + crypto.randomBytes(8).toString('hex');
  p[token] = { userId, agentId, name: (name || '').trim() || 'My machine', createdAt: new Date().toISOString() };
  writePairings(p);
  return { token, agentId, name: p[token].name };
}

// Live agent links: agentId -> { sse, pending: Map(reqId -> { res, timer }), userId, name }
const agents = new Map();
const connectedAgentsForUser = (userId) => [...agents.entries()].filter(([, e]) => e.userId === userId).map(([agentId, entry]) => ({ agentId, entry }));
let reqSeq = 1;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const sendJson = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
const readJson = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); });
const readRaw = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
function parseCookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
const currentUser = (req) => userForToken(parseCookies(req)['cc_session']);
const setCookie = (res, t) => res.setHeader('Set-Cookie', `cc_session=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
const clearCookie = (res) => res.setHeader('Set-Cookie', 'cc_session=; HttpOnly; Path=/; Max-Age=0');
const assetBuild = () => { let m = 0; for (const f of ['app.js', 'styles.css', 'index.html']) { try { m = Math.max(m, fs.statSync(path.join(WEB_DIR, f)).mtimeMs); } catch { /* */ } } return Math.round(m); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const { pathname } = u;

  // ---- agent channel: a user's machine dials in here (outbound) ----
  if (pathname === '/agent/connect') {
    const pr = pairingFor(u.searchParams.get('token'));
    if (!pr) { res.writeHead(401); return res.end('bad pairing token'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const entry = { sse: res, pending: new Map(), userId: pr.userId, name: pr.name };
    // Only displace a prior link to THIS machine (a reconnect) — other machines
    // on the same account stay connected.
    if (agents.has(pr.agentId)) try { agents.get(pr.agentId).sse.end(); } catch { /* */ }
    agents.set(pr.agentId, entry);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25000);
    req.on('close', () => { clearInterval(ping); if (agents.get(pr.agentId) === entry) agents.delete(pr.agentId); });
    return;
  }
  if (pathname === '/agent/respond' && req.method === 'POST') {
    const pr = pairingFor(req.headers['x-pair-token']);
    const entry = pr && agents.get(pr.agentId);
    const body = await readJson(req);
    if (entry && entry.pending.has(body.id)) {
      const { res: bres, timer } = entry.pending.get(body.id);
      clearTimeout(timer); entry.pending.delete(body.id);
      try { bres.writeHead(body.status || 200, body.headers || { 'Content-Type': 'application/json' }); bres.end(body.body != null ? body.body : ''); } catch { /* client gone */ }
    }
    return sendJson(res, 200, { ok: true });
  }

  // ---- broker-local endpoints ----
  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, broker: true, build: assetBuild() });
  if (pathname === '/api/auth/status') { const me = currentUser(req); return sendJson(res, 200, { hasUsers: hasUsers(), user: me, agentConnected: !!(me && connectedAgentsForUser(me.id).length) }); }
  if (pathname === '/api/auth/register' && req.method === 'POST') { const b = await readJson(req); const r = registerUser(b.email, b.password, b.invite); if (!r.ok) return sendJson(res, 400, r); setCookie(res, createSession(r.user.id)); return sendJson(res, 200, { ok: true, user: r.user }); }
  if (pathname === '/api/auth/login' && req.method === 'POST') { const b = await readJson(req); const me = verifyLogin(b.email, b.password); if (!me) return sendJson(res, 401, { error: 'Wrong email or password.' }); setCookie(res, createSession(me.id)); return sendJson(res, 200, { ok: true, user: me }); }
  if (pathname === '/api/auth/logout' && req.method === 'POST') { destroySession(parseCookies(req)['cc_session']); clearCookie(res); return sendJson(res, 200, { ok: true }); }
  if (pathname === '/api/auth/invite') { const me = currentUser(req); if (!me) return sendJson(res, 401, { error: 'Sign in required.' }); if (req.method === 'POST') return sendJson(res, 200, { ok: true, code: createInvite(me.id) }); return sendJson(res, 200, { invites: listInvites() }); }
  if (pathname === '/api/pair' && req.method === 'POST') {
    // Back-compat: get-or-create this account's first machine, return its token.
    const me = currentUser(req); if (!me) return sendJson(res, 401, { error: 'Sign in required.' });
    let rec = pairingsForUser(me.id)[0];
    if (!rec) rec = mintMachine(me.id, 'My machine');
    return sendJson(res, 200, { ok: true, token: rec.token, agentId: rec.agentId, connected: agents.has(rec.agentId) });
  }
  // ---- machines: one account, many computers ----
  if (pathname === '/api/machines' && req.method === 'GET') {
    const me = currentUser(req); if (!me) return sendJson(res, 401, { error: 'Sign in required.' });
    // Never leak stored tokens here — they're shown only once, at mint time.
    const machines = pairingsForUser(me.id).map((r) => ({ agentId: r.agentId, name: r.name || 'My machine', createdAt: r.createdAt || null, connected: agents.has(r.agentId) }));
    return sendJson(res, 200, { ok: true, machines });
  }
  if (pathname === '/api/machines' && req.method === 'POST') {
    const me = currentUser(req); if (!me) return sendJson(res, 401, { error: 'Sign in required.' });
    const b = await readJson(req);
    const m = mintMachine(me.id, b.name || 'New machine');
    return sendJson(res, 200, { ok: true, ...m });
  }
  if (pathname === '/api/machines/rename' && req.method === 'POST') {
    const me = currentUser(req); if (!me) return sendJson(res, 401, { error: 'Sign in required.' });
    const b = await readJson(req); const p = readPairings(); let changed = false;
    for (const [t, v] of Object.entries(p)) {
      const rec = asRecord(t, v);
      if (rec.userId === me.id && rec.agentId === b.agentId) { p[t] = { userId: rec.userId, agentId: rec.agentId, name: (b.name || '').trim() || rec.name, createdAt: rec.createdAt }; changed = true; }
    }
    if (changed) { writePairings(p); const e = agents.get(b.agentId); if (e) e.name = (b.name || '').trim() || e.name; }
    return sendJson(res, 200, { ok: changed });
  }
  if (pathname === '/api/machines/remove' && req.method === 'POST') {
    const me = currentUser(req); if (!me) return sendJson(res, 401, { error: 'Sign in required.' });
    const b = await readJson(req); const p = readPairings(); let changed = false;
    for (const [t, v] of Object.entries(p)) {
      const rec = asRecord(t, v);
      if (rec.userId === me.id && rec.agentId === b.agentId) { delete p[t]; changed = true; }
    }
    if (changed) writePairings(p);
    const e = agents.get(b.agentId);
    if (e && e.userId === me.id) { try { e.sse.end(); } catch { /* */ } agents.delete(b.agentId); }
    return sendJson(res, 200, { ok: changed });
  }

  // ---- everything else under /api → proxy to the user's own machine ----
  if (pathname.startsWith('/api/')) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: 'Sign in required.' });
    // Route to the machine the client picked (X-CC-Machine), if it's theirs and
    // online; otherwise default to their first connected machine.
    const want = req.headers['x-cc-machine'];
    let entry = null;
    if (want) { if (pairingsForUser(me.id).some((r) => r.agentId === want)) entry = agents.get(want) || null; }
    else { const first = connectedAgentsForUser(me.id)[0]; entry = first ? first.entry : null; }
    if (!entry) return sendJson(res, 503, { error: 'agent-offline', message: 'That machine isn’t connected. Start the Vibe Center agent + bridge on it with its pairing token.' });
    const id = 'r' + (reqSeq++);
    const body = await readRaw(req);
    const timer = setTimeout(() => { if (entry.pending.has(id)) { entry.pending.delete(id); try { sendJson(res, 504, { error: 'Your machine did not respond in time.' }); } catch { /* */ } } }, 30000);
    entry.pending.set(id, { res, timer });
    try { entry.sse.write(`data: ${JSON.stringify({ id, method: req.method, path: req.url, headers: { 'content-type': req.headers['content-type'] || '' }, body })}\n\n`); }
    catch { clearTimeout(timer); entry.pending.delete(id); return sendJson(res, 502, { error: 'Lost the link to your machine.' }); }
    return;
  }

  // ---- static website ----
  let rel = pathname === '/' ? '/index.html' : pathname;
  const fp = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`\n  🛰️  Vibe Center broker → http://localhost:${PORT}\n  accounts: ${process.env.CC_AUTH_FILE}\n`));
