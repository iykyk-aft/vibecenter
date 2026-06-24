// Local account + session store for the agent. Phase 1 of multi-user access:
// each agent (a user's own machine) has its own owner login. Real per-user
// accounts + a cloud broker that routes between them come in a later phase.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AUTH_FILE = path.join(process.cwd(), 'data', 'auth.json');
const SESSION_TTL = 30 * 86400e3; // 30 days

function read() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch { return { users: [], sessions: {} }; }
}
function write(d) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(d, null, 2));
}
function hashPw(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

export function hasUsers() { return read().users.length > 0; }

export function registerUser(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (!password || String(password).length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const d = read();
  if (d.users.some((u) => u.email === email)) return { ok: false, error: 'That email is already registered.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: 'u-' + crypto.randomBytes(6).toString('hex'), email, salt, hash: hashPw(password, salt), createdAt: Date.now() };
  d.users.push(user);
  write(d);
  return { ok: true, user: { id: user.id, email: user.email } };
}

export function verifyLogin(email, password) {
  email = String(email || '').trim().toLowerCase();
  const u = read().users.find((x) => x.email === email);
  if (!u) return null;
  const a = Buffer.from(hashPw(password, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: u.id, email: u.email };
}

export function createSession(userId) {
  const d = read();
  const token = crypto.randomBytes(32).toString('hex');
  d.sessions[token] = { userId, exp: Date.now() + SESSION_TTL };
  write(d);
  return token;
}
export function destroySession(token) {
  if (!token) return;
  const d = read();
  if (d.sessions[token]) { delete d.sessions[token]; write(d); }
}
export function userForToken(token) {
  if (!token) return null;
  const d = read();
  const s = d.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) { delete d.sessions[token]; write(d); return null; }
  const u = d.users.find((x) => x.id === s.userId);
  return u ? { id: u.id, email: u.email } : null;
}
