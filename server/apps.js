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

function hasXcodeProject(cwd) {
  try { return fs.readdirSync(cwd).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace')); }
  catch { return false; }
}

// Best-effort, cheap (a few stat/reads) detection of the app's toolchain from
// its marker files, so the fleet view can offer the right build action and show
// which platforms (iOS / Android) it targets.
const STACK_LABEL = {
  flutter: 'Flutter', expo: 'Expo', 'react-native': 'React Native',
  'native-ios': 'iOS (native)', 'native-android': 'Android (native)', node: 'Node',
};
export function detectStack(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const has = (f) => { try { return fs.existsSync(path.join(cwd, f)); } catch { return false; } };
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const iosDir = has('ios');
  const androidDir = has('android');

  let stack = null, ios = false, android = false;
  if (has('pubspec.yaml')) { stack = 'flutter'; ios = true; android = true; }
  else if (deps.expo) { stack = 'expo'; ios = true; android = true; }
  else if (deps['react-native']) { stack = 'react-native'; ios = true; android = true; }
  else if (iosDir || has('Podfile') || hasXcodeProject(cwd)) { stack = 'native-ios'; ios = true; }
  else if (androidDir || has('build.gradle') || has('settings.gradle') || has('gradlew')) { stack = 'native-android'; android = true; }
  else if (pkg) { stack = 'node'; }
  if (!stack) return null;

  // Presence of platform folders refines the flags regardless of detected stack.
  if (iosDir) ios = true;
  if (androidDir) android = true;
  return { stack, label: STACK_LABEL[stack] || stack, ios, android };
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
