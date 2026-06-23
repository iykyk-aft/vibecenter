import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export function parseGitHubUrl(u) {
  if (!u) return null;
  const m = u.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function getCustomApps() {
  return readConfig().customApps || [];
}

export function addApp({ name, path: p, github }) {
  const cfg = readConfig();
  if (!cfg.customApps) cfg.customApps = [];
  const gh = parseGitHubUrl(github);
  const cleanPath = p ? p.trim() : null;
  const displayName = (name && name.trim()) ||
    (cleanPath ? path.basename(cleanPath.replace(/[\\/]+$/, '')) : (gh ? gh.repo : 'app'));
  if (!cleanPath && !gh) return { ok: false, error: 'Provide a folder path or a GitHub URL' };
  if (cleanPath && !fs.existsSync(cleanPath)) return { ok: false, error: 'Folder does not exist: ' + cleanPath };
  const id = 'custom-' + Math.abs(hash(displayName + (cleanPath || '') + (github || ''))).toString(36);
  if (cfg.customApps.some((a) => a.id === id)) return { ok: true, already: true };
  cfg.customApps.push({ id, name: displayName, path: cleanPath, github: gh ? `${gh.owner}/${gh.repo}` : null });
  writeConfig(cfg);
  return { ok: true, id };
}

export function removeApp(id) {
  const cfg = readConfig();
  if (!cfg.customApps) return { ok: false };
  const before = cfg.customApps.length;
  cfg.customApps = cfg.customApps.filter((a) => a.id !== id);
  writeConfig(cfg);
  return { ok: cfg.customApps.length < before };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

// Build synthetic project entries for custom apps not already auto-discovered.
export function syntheticProjects(discovered) {
  const known = new Set(discovered.map((p) => (p.cwd || '').toLowerCase().replace(/[\\/]+$/, '')));
  const out = [];
  for (const a of getCustomApps()) {
    const key = (a.path || '').toLowerCase().replace(/[\\/]+$/, '');
    if (key && known.has(key)) continue; // already tracked via Claude history
    out.push({
      id: a.id, name: a.name, cwd: a.path || null,
      custom: true, githubOverride: a.github,
      sessionCount: 0, liveCount: 0, lastActivity: 0,
      cost: 0, billableTokens: 0, toolCalls: 0,
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      modelTokens: {}, daily: {}, sessions: [],
    });
  }
  return out;
}
