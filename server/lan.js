// Same-account LAN auto-discovery. When two computers are signed into the same
// Vibe Center account (same email + password → same derived account key) and
// both have LAN access on, they find each other on the local network over UDP
// and link automatically — no tokens, no URLs, no buttons.
//
// What crosses the wire:
//   • UDP announce (broadcast): { app, acct, mid, name, httpPort, ts }
//       acct = a SHA-256 fingerprint of the account key (not the key itself);
//       mid  = a random per-process machine id used for routing.
//   • Per-request auth header to a peer's HTTP API: "<ts>.<hmac(key, ts)>" —
//       a short-lived HMAC of the shared key, so a peer can prove "same account"
//       without the key ever travelling in the clear.
//
// The key never leaves the machine; only its fingerprint and time-bounded HMACs do.

import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';

const DISCOVERY_PORT = Number(process.env.CC_DISCOVERY_PORT) || 7877;
const ANNOUNCE_MS = 4000;
const PEER_TTL_MS = 15000;     // drop a peer not heard from in this long
const AUTH_SKEW_MS = 90000;    // accept peer-auth HMACs within ±90s

const MID = 'mid-' + crypto.randomBytes(8).toString('hex'); // this process / machine

let sock = null;
let announceTimer = null;
let sweepTimer = null;
let getIdentity = () => null;  // injected: () => { id, key, name } | null
let httpPort = 0;
const peers = new Map();        // mid -> { mid, name, ip, port, url, lastSeen }

function acctFingerprint(key) {
  return crypto.createHash('sha256').update('acct:' + key).digest('hex').slice(0, 32);
}

// Start broadcasting + listening. Safe to call once; identity may not exist yet
// (no one signed in) — we re-check it every tick and begin announcing once it does.
export function startDiscovery(opts) {
  httpPort = opts.httpPort;
  getIdentity = opts.getIdentity;
  if (sock) return;

  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => { /* keep the agent alive even if discovery can't bind */ });
  sock.on('message', onMessage);
  sock.bind(DISCOVERY_PORT, () => { try { sock.setBroadcast(true); } catch { /* */ } });

  announceTimer = setInterval(announce, ANNOUNCE_MS);
  sweepTimer = setInterval(sweep, 5000);
  announce();
}

export function stopDiscovery() {
  clearInterval(announceTimer); clearInterval(sweepTimer);
  try { sock && sock.close(); } catch { /* */ }
  sock = null; peers.clear();
}

function announce() {
  const id = getIdentity();
  if (!id || !sock) return;
  const msg = Buffer.from(JSON.stringify({
    app: 'vibecenter', acct: acctFingerprint(id.key), mid: MID,
    name: id.name || os.hostname(), httpPort, ts: Date.now(),
  }));
  try { sock.send(msg, DISCOVERY_PORT, '255.255.255.255'); } catch { /* */ }
}

function onMessage(buf, rinfo) {
  const id = getIdentity();
  if (!id) return;
  let m; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
  if (!m || m.app !== 'vibecenter' || m.mid === MID) return;       // not us / ourselves
  if (m.acct !== acctFingerprint(id.key)) return;                  // different account → ignore
  if (!m.httpPort || !rinfo || !rinfo.address) return;
  const ip = rinfo.address;
  peers.set(m.mid, {
    mid: m.mid, name: String(m.name || 'Machine').slice(0, 60),
    ip, port: m.httpPort, url: `http://${ip}:${m.httpPort}`, lastSeen: Date.now(),
  });
}

function sweep() {
  const now = Date.now();
  for (const [mid, p] of peers) if (now - p.lastSeen > PEER_TTL_MS) peers.delete(mid);
}

// Live same-account peers on the network (no secrets).
export function lanPeers() {
  sweep();
  return [...peers.values()].map((p) => ({ mid: p.mid, name: p.name, url: p.url, ip: p.ip, port: p.port }));
}
export function findPeer(mid) {
  sweep();
  return peers.get(mid) || null;
}
export function selfMid() { return MID; }

// ---- per-request peer auth (HMAC of the shared key) ------------------------
// Outgoing: sign with our key so a peer accepts our proxied request.
export function accountAuthHeader() {
  const id = getIdentity();
  if (!id) return null;
  const ts = Date.now();
  const mac = crypto.createHmac('sha256', id.key).update(String(ts)).digest('hex');
  return `${ts}.${mac}`;
}
// Incoming: verify a peer's header proves the same account (fresh + valid HMAC).
export function verifyAccountHeader(value) {
  if (!value || typeof value !== 'string') return false; // fast path: no header
  const id = getIdentity();
  if (!id) return false;
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  const ts = Number(value.slice(0, dot));
  const mac = value.slice(dot + 1);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > AUTH_SKEW_MS) return false;
  const expect = crypto.createHmac('sha256', id.key).update(String(ts)).digest('hex');
  const a = Buffer.from(mac, 'hex'); const b = Buffer.from(expect, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
