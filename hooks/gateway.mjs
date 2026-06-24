#!/usr/bin/env node
// Blocking PreToolUse hook: routes a tool call to the Command Center for an
// approve/deny decision. Falls through to the normal Claude Code prompt if the
// gateway is off, the server is unreachable, or no decision arrives in time —
// so it can never wedge a session.
const BASE = process.env.CC_URL || 'http://localhost:7878';
const TIMEOUT_MS = 50000; // stay under the hook's configured timeout
const POLL_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jfetch(url, opts, ms = 1500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: c.signal }); return await r.json(); }
  finally { clearTimeout(t); }
}
function passthrough() { process.exit(0); } // empty stdout → normal flow
function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function summarize(tool, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command).slice(0, 200);
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  return Object.keys(input).slice(0, 4).join(', ');
}
const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let d = {};
  try { d = JSON.parse(raw); } catch { return passthrough(); }
  const cwd = d.cwd || process.cwd();
  let reg;
  try {
    reg = await jfetch(`${BASE}/api/approval-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: d.tool_name, input: summarize(d.tool_name, d.tool_input), cwd, project: base(cwd), session: d.session_id }),
    });
  } catch { return passthrough(); } // server down → never block
  if (!reg || !reg.active) return passthrough();
  // Workspace set to always-allow → approve immediately, no dashboard round-trip.
  if (reg.decision === 'allow') return decide('allow', 'Always-allow is on for this workspace');
  if (reg.decision === 'deny') return decide('deny', 'Blocked by workspace setting');
  if (!reg.id) return passthrough();

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let v;
    try { v = await jfetch(`${BASE}/api/approval-poll?id=${encodeURIComponent(reg.id)}`); } catch { continue; }
    if (!v) continue;
    if (v.status === 'allow') return decide('allow', 'Approved from Command Center');
    if (v.status === 'deny') return decide('deny', v.reason || 'Denied from Command Center');
    if (v.status === 'gone') return passthrough();
  }
  return passthrough(); // timed out → fall back to the VS Code prompt
});
