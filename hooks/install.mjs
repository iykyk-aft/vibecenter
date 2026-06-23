#!/usr/bin/env node
// Wires the Command Center hooks into ~/.claude/settings.json (idempotent, backed up).
//   node hooks/install.mjs              install
//   node hooks/install.mjs --uninstall  remove
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const LOGGER = `node "${path.join(HERE, 'logger.mjs')}"`;
const GATEWAY = `node "${path.join(HERE, 'gateway.mjs')}"`;
const uninstall = process.argv.includes('--uninstall');

// event -> list of { command, matcher, timeout? }
const SPECS = {
  Notification: [{ command: LOGGER, matcher: '' }],
  PreToolUse: [
    { command: LOGGER, matcher: '*' },
    { command: GATEWAY, matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', timeout: 90 },
  ],
};
const OURS = new Set([LOGGER, GATEWAY]);

const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
fs.copyFileSync(SETTINGS, SETTINGS + '.cc-backup');
if (!settings.hooks) settings.hooks = {};

for (const [event, specs] of Object.entries(SPECS)) {
  // Strip any prior Command Center entries so re-running stays clean.
  let groups = (settings.hooks[event] || []).map((g) => ({
    ...g, hooks: (g.hooks || []).filter((h) => !OURS.has(h.command)),
  })).filter((g) => (g.hooks || []).length > 0);

  if (!uninstall) {
    for (const s of specs) {
      const hook = { type: 'command', command: s.command };
      if (s.timeout) hook.timeout = s.timeout;
      groups.push({ matcher: s.matcher, hooks: [hook] });
    }
  }
  settings.hooks[event] = groups;
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
console.log(uninstall
  ? '✓ Command Center hooks removed.'
  : '✓ Command Center hooks installed:\n  • logger (Notification + PreToolUse) — live activity/approval feed\n  • gateway (PreToolUse: Edit/Write/MultiEdit/NotebookEdit/Bash) — approve from the dashboard');
console.log(`  backup: ${SETTINGS}.cc-backup`);
console.log('  Enable the gateway on the Approvals screen, then restart running sessions.');
