// Restart helper: spawned detached by POST /api/restart. Waits for the old
// server to release the port, then starts a fresh one (also detached) so the
// running agent picks up server-code updates.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 7878;
const SERVER = path.join(ROOT, 'server', 'server.js');

function up() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/api/health`, (r) => { r.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(600, () => { req.destroy(); resolve(false); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until the old server is gone (port free), then start the new one.
for (let i = 0; i < 50 && (await up()); i++) await sleep(200); // up to ~10s
spawn(process.execPath, [SERVER], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
setTimeout(() => process.exit(0), 800);
