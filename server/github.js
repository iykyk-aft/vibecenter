import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execFileP = promisify(execFile);

// cwd -> { owner, repo } | null
const remoteCache = new Map();
// "owner/repo" -> { ts, data }
const metricsCache = new Map();
const METRICS_TTL_MS = 5 * 60 * 1000;

function parseRemote(url) {
  if (!url) return null;
  // git@github.com:owner/repo.git  OR  https://github.com/owner/repo.git
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export async function detectRepo(cwd) {
  if (!cwd) return null;
  if (remoteCache.has(cwd)) return remoteCache.get(cwd);
  let result = null;
  try {
    if (fs.existsSync(cwd)) {
      const { stdout } = await execFileP('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { timeout: 5000 });
      result = parseRemote(stdout.trim());
    }
  } catch { result = null; }
  remoteCache.set(cwd, result);
  return result;
}

// Local git stats — works without a token, for any cloned repo.
export async function localGit(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const run = async (args) => {
    try { return (await execFileP('git', ['-C', cwd, ...args], { timeout: 5000 })).stdout.trim(); }
    catch { return null; }
  };
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return null;
  const commitCount = await run(['rev-list', '--count', 'HEAD']);
  const lastCommit = await run(['log', '-1', '--format=%cI']);
  const lastSubject = await run(['log', '-1', '--format=%s']);
  const status = await run(['status', '--porcelain']);
  const dirty = status ? status.split('\n').filter(Boolean).length : 0;
  return {
    branch,
    commits: commitCount ? Number(commitCount) : null,
    lastCommit,
    lastSubject,
    dirtyFiles: dirty,
  };
}

async function gh(pathname, token) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'claude-command-center',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function repoMetrics(owner, repo, token) {
  const key = `${owner}/${repo}`;
  const hit = metricsCache.get(key);
  if (hit && (Date.now() - hit.ts) < METRICS_TTL_MS) return hit.data;
  if (!token) return null;

  try {
    const [info, pulls, commits, runs] = await Promise.all([
      gh(`/repos/${owner}/${repo}`, token),
      gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=10`, token).catch(() => []),
      gh(`/repos/${owner}/${repo}/commits?per_page=10`, token).catch(() => []),
      gh(`/repos/${owner}/${repo}/actions/runs?per_page=1`, token).catch(() => ({ workflow_runs: [] })),
    ]);

    const latestRun = (runs.workflow_runs || [])[0] || null;
    const data = {
      owner, repo,
      url: info.html_url,
      stars: info.stargazers_count,
      openIssues: info.open_issues_count - (pulls.length || 0),
      openPRs: pulls.length,
      defaultBranch: info.default_branch,
      pushedAt: info.pushed_at,
      language: info.language,
      ci: latestRun ? {
        status: latestRun.status,
        conclusion: latestRun.conclusion,
        name: latestRun.name,
        url: latestRun.html_url,
        at: latestRun.updated_at,
      } : null,
      recentCommits: (commits || []).slice(0, 5).map((c) => ({
        sha: c.sha.slice(0, 7),
        message: (c.commit.message || '').split('\n')[0].slice(0, 80),
        author: c.commit.author?.name,
        date: c.commit.author?.date,
        url: c.html_url,
      })),
      prs: (pulls || []).slice(0, 5).map((p) => ({
        number: p.number,
        title: p.title.slice(0, 80),
        url: p.html_url,
        draft: p.draft,
        user: p.user?.login,
      })),
    };
    metricsCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (e) {
    return { owner, repo, error: e.message };
  }
}

export async function githubFor(cwd, token) {
  const repo = await detectRepo(cwd);
  const local = await localGit(cwd);
  if (!repo) return { repo: null, local };
  const metrics = await repoMetrics(repo.owner, repo.repo, token);
  return { repo, local, metrics };
}
