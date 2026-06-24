import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Resolve the Claude Code CLI. It ships inside the VS Code extension
// (resources/native-binary/claude.exe) and the desktop app; also try PATH.
let cachedBin = null;
export function resolveClaudeBin(override) {
  if (override && fs.existsSync(override)) return override;
  if (cachedBin && fs.existsSync(cachedBin)) return cachedBin;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [];

  // VS Code extensions — pick the highest installed version.
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const versions = fs.readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .map((d) => ({ d, v: d.match(/claude-code-(\d+\.\d+\.\d+)/)?.[1] || '0.0.0' }))
      .sort((a, b) => cmpVer(b.v, a.v));
    for (const { d } of versions) {
      candidates.push(path.join(extDir, d, 'resources', 'native-binary', exe));
    }
  } catch { /* no extensions dir */ }

  // Desktop app bundle.
  candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Packages',
    'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code'));

  for (const c of candidates) {
    if (fs.existsSync(c)) { cachedBin = c; return c; }
  }
  cachedBin = exe; // fall back to PATH
  return cachedBin;
}

function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// Spawn a headless query in `cwd` and stream parsed events to onEvent().
// Read-only (plan permission mode) — Claude can explore but won't edit.
// Returns the child process so the caller can kill it on client disconnect.
export function runQuery({ cwd, prompt, model, binOverride, resumeId, permissionMode }, onEvent) {
  const bin = resolveClaudeBin(binOverride);
  // 'plan' = read-only exploration; 'default' = can edit/run, but Edit/Write/Bash
  // are gated by the Command Center approvals hook so the user confirms each.
  const mode = permissionMode === 'default' ? 'default' : 'plan';
  const args = ['-p', prompt, '--permission-mode', mode,
    '--output-format', 'stream-json', '--verbose'];
  if (resumeId) args.push('--resume', resumeId);
  if (model) args.push('--model', model);

  let child;
  try {
    child = spawn(bin, args, { cwd, windowsHide: true });
  } catch (e) {
    onEvent({ type: 'error', text: `Could not launch Claude CLI: ${e.message}` });
    onEvent({ type: 'done', error: true });
    return null;
  }

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      handleEvent(o, onEvent);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => onEvent({ type: 'stderr', text: String(d).slice(0, 400) }));
  child.on('error', (e) => { onEvent({ type: 'error', text: e.message }); onEvent({ type: 'done', error: true }); });
  child.on('close', (code) => {
    if (buf.trim()) { try { handleEvent(JSON.parse(buf.trim()), onEvent); } catch { /* */ } }
    onEvent({ type: 'done', code });
  });
  return child;
}

function handleEvent(o, onEvent) {
  if (o.type === 'system' && o.subtype === 'init') {
    onEvent({ type: 'started', model: o.model, tools: (o.tools || []).length, sessionId: o.session_id });
  } else if (o.type === 'assistant' && o.message) {
    for (const b of o.message.content || []) {
      if (b.type === 'text' && b.text) onEvent({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') onEvent({ type: 'tool', tool: b.name });
    }
  } else if (o.type === 'result') {
    onEvent({ type: 'done', cost: o.total_cost_usd, turns: o.num_turns, subtype: o.subtype, durationMs: o.duration_ms });
  }
}
