import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Resolve the GitHub CLI. winget installs it here on Windows; also try PATH so
// a fresh install works without restarting the server (PATH may be stale).
let cachedGh = null;
export function resolveGhBin() {
  if (cachedGh) return cachedGh;
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const candidates = [exe];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['LOCALAPPDATA'] || '', 'GitHubCLI', 'bin', 'gh.exe'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
    );
  }
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) { cachedGh = c; return c; }
  }
  return null;
}

function run(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// gh install + auth state, for the UI to show what's possible.
export function ghStatus() {
  const bin = resolveGhBin();
  if (!bin) return { installed: false, authed: false, user: null };
  const a = run(bin, ['auth', 'status'], process.cwd());
  const authed = a.code === 0;
  let user = null;
  if (authed) {
    const u = run(bin, ['api', 'user', '--jq', '.login'], process.cwd());
    if (u.code === 0) user = u.out;
  }
  return { installed: true, authed, user };
}

// Where new project folders are created. Configurable; defaults to ~/claude-projects.
export function projectsRoot(cfg) {
  return (cfg && cfg.projectsRoot) || path.join(os.homedir(), 'claude-projects');
}

function slugify(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const README = (name) => `# ${name}\n\nScaffolded from the Command Center.\n`;
const GITIGNORE = 'node_modules/\n.env\n.env.*\ndist/\n.DS_Store\n*.log\n';

// Create a folder, git-init it, optional GitHub repo, and return details.
// Does NOT register the app — the caller does that so it can reuse addApp().
export function scaffoldProject({ name, root, createRepo, visibility }) {
  const slug = slugify(name);
  if (!slug) return { ok: false, error: 'Provide a name with at least one letter or number.' };
  const dir = path.join(root, slug);
  if (fs.existsSync(dir)) return { ok: false, error: `Folder already exists: ${dir}` };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), README(name));
  fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);

  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const gi = run(git, ['init', '-b', 'main'], dir);
  if (gi.code !== 0) return { ok: false, error: 'git init failed: ' + (gi.err || gi.out), path: dir };

  // Ensure a commit identity even if the user has no global git config, so the
  // initial commit (and gh's --push) never fails. Prefer the signed-in gh user.
  const ghUser = ghStatus().user;
  if (run(git, ['config', 'user.name'], dir).code !== 0) {
    run(git, ['config', 'user.name', ghUser || 'Command Center'], dir);
    run(git, ['config', 'user.email', ghUser ? `${ghUser}@users.noreply.github.com` : 'command-center@localhost'], dir);
  }

  run(git, ['add', '-A'], dir);
  const ci = run(git, ['commit', '-m', 'Initial commit (scaffolded from Command Center)'], dir);
  // commit may still fail in odd states — surface but keep the folder.
  const committed = ci.code === 0;

  let github = null, repoError = null;
  if (createRepo) {
    const gh = resolveGhBin();
    if (!gh) {
      repoError = 'GitHub CLI not installed — created the local folder only.';
    } else {
      const vis = visibility === 'public' ? '--public' : '--private';
      const args = ['repo', 'create', slug, '--source', '.', '--remote', 'origin', vis];
      if (committed) args.push('--push');
      const cr = run(gh, args, dir);
      if (cr.code === 0) {
        const view = run(gh, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], dir);
        github = view.code === 0 ? view.out : null;
      } else {
        repoError = 'gh repo create failed: ' + (cr.err || cr.out);
      }
    }
  }

  return { ok: true, path: dir, slug, github, committed, repoError };
}
