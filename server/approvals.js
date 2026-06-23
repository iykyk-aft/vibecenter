import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
// The PreToolUse hook appends one JSON line per permission event here.
const EVENTS_FILE = path.join(process.cwd(), 'data', 'approval-events.jsonl');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

// Group an allow rule like "Bash(git*)" -> { tool: "Bash", arg: "git*" }.
function classify(rule) {
  const m = rule.match(/^([A-Za-z_]+)\((.*)\)$/);
  if (m) return { tool: m[1], arg: m[2], raw: rule };
  return { tool: rule, arg: null, raw: rule };
}

export function getAllowlist() {
  const s = readSettings();
  const allow = (s.permissions && s.permissions.allow) || [];
  const byTool = {};
  for (const rule of allow) {
    const { tool, arg } = classify(rule);
    if (!byTool[tool]) byTool[tool] = [];
    byTool[tool].push({ raw: rule, arg });
  }
  return {
    count: allow.length,
    byTool: Object.entries(byTool)
      .map(([tool, rules]) => ({ tool, rules }))
      .sort((a, b) => b.rules.length - a.rules.length),
  };
}

export function addRule(rule) {
  const s = readSettings();
  if (!s.permissions) s.permissions = {};
  if (!s.permissions.allow) s.permissions.allow = [];
  if (s.permissions.allow.includes(rule)) return { ok: true, already: true };
  backupSettings();
  s.permissions.allow.push(rule);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return { ok: true };
}

export function removeRule(rule) {
  const s = readSettings();
  if (!s.permissions || !s.permissions.allow) return { ok: false };
  const idx = s.permissions.allow.indexOf(rule);
  if (idx === -1) return { ok: false };
  backupSettings();
  s.permissions.allow.splice(idx, 1);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return { ok: true };
}

function backupSettings() {
  try {
    const dir = path.join(process.cwd(), 'data', 'settings-backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SETTINGS_FILE, path.join(dir, `settings.${stamp}.json`));
  } catch { /* best-effort */ }
}

// Recent permission events logged by the hook. Most recent first.
export function getEvents(limit = 50) {
  try {
    const text = fs.readFileSync(EVENTS_FILE, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const events = [];
    for (const l of lines.slice(-limit)) {
      try { events.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return events.reverse();
  } catch { return []; }
}

export function approvalsSummary() {
  return {
    allowlist: getAllowlist(),
    events: getEvents(50),
  };
}
