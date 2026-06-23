// Vibe Center desktop launcher: ensure the server is up (start it hidden if
// not), then open the dashboard in a chromeless Edge "app" window so it looks
// and behaves like a native desktop app.
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 7878;
const APP_URL = `http://localhost:${PORT}`;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(APP_URL + '/api/config', (r) => { r.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

// Find a Chromium-based browser that supports chromeless --app mode.
function findChromium() {
  const PF = process.env.ProgramFiles || 'C:/Program Files';
  const PFx = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const LA = process.env.LOCALAPPDATA || '';
  const cands = [
    `${PF}/Google/Chrome/Application/chrome.exe`,
    `${PFx}/Google/Chrome/Application/chrome.exe`,
    path.join(LA, 'Google/Chrome/Application/chrome.exe'),
    `${PF}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    `${PFx}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    path.join(LA, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    `${PFx}/Microsoft/Edge/Application/msedge.exe`,
    `${PF}/Microsoft/Edge/Application/msedge.exe`,
    path.join(LA, 'Vivaldi/Application/vivaldi.exe'),
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

function openWindow() {
  const browser = findChromium();
  if (browser) {
    const profile = path.join(ROOT, 'data', 'app-window'); // dedicated profile = own app identity
    const args = [
      `--app=${APP_URL}`,
      `--user-data-dir=${profile}`,
      '--window-size=1460,940',
      '--no-first-run', '--no-default-browser-check',
    ];
    spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    // No Chromium browser — open the default browser as a normal tab.
    spawn('cmd', ['/c', 'start', '', APP_URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

const up = await ping();
if (!up) {
  startServer();
  for (let i = 0; i < 30; i++) { // wait up to ~12s
    await new Promise((r) => setTimeout(r, 400));
    if (await ping()) break;
  }
}
openWindow();
setTimeout(() => process.exit(0), 1500);
