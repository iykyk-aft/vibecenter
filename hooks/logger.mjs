#!/usr/bin/env node
// Claude Code hook → appends one event line to the command center's log.
// Wired for Notification (permission/attention needed) and PreToolUse
// (live activity feed). Always exits 0 so it never blocks a session.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LOG = path.join(HERE, '..', 'data', 'approval-events.jsonl');

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
  process.exit(0);
});
