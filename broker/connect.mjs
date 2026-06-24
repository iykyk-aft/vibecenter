// Vibe Center connect bridge — runs on a user's machine. Dials OUT to the broker
// over SSE and relays each forwarded request to the local agent (loopback, with
// the agent's internal token so it bypasses the local login gate). No inbound
// ports are opened on the user's network.
//
//   BROKER_URL=https://vibe.example.com node broker/connect.mjs <PAIR_TOKEN>
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const BROKER = (process.env.BROKER_URL || 'http://localhost:7900').replace(/\/+$/, '');
const AGENT = (process.env.AGENT_URL || 'http://localhost:7878').replace(/\/+$/, '');
const TOKEN = process.env.PAIR_TOKEN || process.argv[2];
let INTERNAL = '';
try { INTERNAL = fs.readFileSync(path.join(ROOT, 'data', 'internal-token'), 'utf8').trim(); } catch { /* agent not started yet */ }

if (!TOKEN) { console.error('Usage: node broker/connect.mjs <PAIR_TOKEN>   (get the token from the website → Connect your machine)'); process.exit(1); }
const libFor = (u) => (new URL(u).protocol === 'https:' ? https : http);

function forward(msg) {
  const target = new URL(msg.path, AGENT);
  const opts = { method: msg.method, headers: { ...(msg.headers || {}), 'X-CC-Internal': INTERNAL } };
  const areq = libFor(AGENT).request(target, opts, (ares) => {
    const chunks = [];
    ares.on('data', (c) => chunks.push(c));
    ares.on('end', () => respond({ id: msg.id, status: ares.statusCode, headers: { 'Content-Type': ares.headers['content-type'] || 'application/json' }, body: Buffer.concat(chunks).toString('utf8') }));
  });
  areq.on('error', (e) => respond({ id: msg.id, status: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'agent error: ' + e.message }) }));
  if (msg.body) areq.write(msg.body);
  areq.end();
}

function respond(payload) {
  const data = JSON.stringify(payload);
  const target = new URL('/agent/respond', BROKER);
  const r = libFor(BROKER).request(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pair-Token': TOKEN, 'Content-Length': Buffer.byteLength(data) } }, (res) => res.resume());
  r.on('error', () => {});
  r.write(data); r.end();
}

function connect() {
  const target = new URL('/agent/connect?token=' + encodeURIComponent(TOKEN), BROKER);
  const req = libFor(BROKER).get(target, (res) => {
    if (res.statusCode !== 200) { console.error(`broker rejected pairing (${res.statusCode}). Check the token.`); process.exit(1); }
    console.log(`✓ bridged ${BROKER}  ⇄  ${AGENT}`);
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { forward(JSON.parse(line.slice(6))); } catch { /* */ } }
      }
    });
    res.on('end', () => { console.log('broker stream ended — reconnecting…'); setTimeout(connect, 2000); });
  });
  req.on('error', (e) => { console.error('broker unreachable:', e.message, '— retrying'); setTimeout(connect, 3000); });
}
connect();
