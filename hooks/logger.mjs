#!/usr/bin/env node
// Claude Code hook → appends one event line to the command center's log.
// Wired for Notification (permission/attention needed) and PreToolUse
// (live activity feed). Always exits 0 so it never blocks a session.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LOG = path.join(HERE, '..', 'data', 'approval-events.jsonl');
const PIDS = path.join(HERE, '..', 'data', 'session-pids.json');

// The hook's own parent is a transient shell that dies immediately, but the
// Claude session process (claude.exe) is a stable ancestor. Walk up to it ONCE
// per session (while the chain is alive) and cache session_id -> claude pid so
// the dashboard can end the session later. Windows only for now.
function resolveClaudePid(startPpid) {
  if (process.platform !== 'win32' || !startPpid) return null;
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 8000 });
    if (!r.stdout) return null;
    let procs = JSON.parse(r.stdout);
    if (!Array.isArray(procs)) procs = [procs];
    const byId = new Map(procs.map((p) => [p.ProcessId, p]));
    let pid = startPpid;
    for (let i = 0; i < 15 && pid; i++) {
      const p = byId.get(pid);
      if (!p) break;
      if (/claude/i.test(p.Name)) return pid;
      pid = p.ParentProcessId;
    }
  } catch { /* best effort */ }
  return null;
}
function recordSessionPid(session, cwd) {
  if (!session) return;
  try {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch { /* fresh */ }
    const cur = map[session];
    if (cur && cur.pid && (Date.now() - (cur.ts || 0) < 60 * 60 * 1000)) return; // cached this hour
    const pid = resolveClaudePid(process.ppid);
    if (!pid) return;
    map[session] = { pid, cwd, ts: Date.now() };
    for (const k of Object.keys(map)) if (Date.now() - (map[k].ts || 0) > 24 * 60 * 60 * 1000) delete map[k];
    fs.writeFileSync(PIDS, JSON.stringify(map));
  } catch { /* never block the session */ }
}

function summarize(tool, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command).slice(0, 160);
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  if (input.url) return String(input.url);
  if (input.pattern) return String(input.pattern);
  return Object.keys(input).slice(0, 3).join(', ');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(raw); } catch { /* tolerate */ }
  const cwd = data.cwd || process.cwd();
  const event = {
    time: Date.now(),
    kind: data.hook_event_name || 'event',     // Notification | PreToolUse | ...
    session: data.session_id || null,
    project: path.basename(cwd.replace(/[\\/]+$/, '')),
    cwd,
    tool: data.tool_name || null,
    summary: data.message || summarize(data.tool_name, data.tool_input),
    ppid: process.ppid,                         // the Claude session is an ancestor of this hook → lets the dashboard end it
  };
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(event) + '\n');
    // Trim the log so it can't grow unbounded (keep last 500 lines).
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 500) fs.writeFileSync(LOG, lines.slice(-500).join('\n') + '\n');
  } catch { /* never block the session on a logging failure */ }
  recordSessionPid(event.session, cwd);
  process.exit(0);
});
