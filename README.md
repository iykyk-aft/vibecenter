# ⚡ Vibe Center

A local **Windows desktop dashboard** that tracks every Claude Code app on your machine —
token usage, cost, live sessions, per-application metrics, the linked GitHub repo's
activity, a live permission/approval feed, the ability to **query any app directly**, and
**approve VS Code permission prompts from the dashboard**. Zero external dependencies;
reads your existing `~/.claude/projects/` transcripts.

## Quick start (browser)

```bash
cd claudeCommandCenter
npm start            # → http://localhost:7878
```

Metrics work immediately by parsing your local Claude Code transcripts. No build step,
no `npm install` (pure Node, ≥18).

## Run it as a desktop app (recommended)

```bash
npm run setup     # generates the ⚡ icon + Start Menu / Desktop shortcuts (one time)
```

Then launch **Vibe Center** from the Start Menu or desktop. It starts the server hidden
and opens in its own chromeless window (no tabs/address bar) — a real Windows app. Uses
Chrome/Edge/Brave `--app` mode if available, otherwise your default browser. Re-launching
reuses the already-running server. `npm run app` does the same from the CLI. The launcher
lives in [`vibecenter/`](vibecenter/).

## Optional setup

**GitHub metrics** (PRs, CI, issues, stars):
1. Create a GitHub Personal Access Token (fine-grained with *repo → contents/metadata read*,
   or a classic token with `repo`).
2. Open the dashboard → **Settings** → paste the token → Save.
   (Stored locally in `data/config.json`; or set the `GITHUB_TOKEN` env var.)

**Live approvals / activity feed:**
```bash
node hooks/install.mjs        # wires a Notification + PreToolUse hook into settings.json (with backup)
node hooks/install.mjs --uninstall   # remove it later
```
Restart any running Claude Code sessions afterward. The hook appends events to
`data/approval-events.jsonl`; the dashboard surfaces them under **Approvals**.

## What each screen shows

- **Overview** — API-equivalent token value, billable tokens, live sessions, model mix,
  30-day token activity, and a ranked list of every application. If you're on a Pro/Max
  subscription it says so: the dollar figure is the *metered-API equivalent* of your
  tokens, **not money charged** — your real cost is the flat subscription fee.
- **Account** — lifetime totals, a rolling **5-hour usage window** gauge (Claude Max paces
  limits in ~5h windows), today / 7-day / 30-day usage, activity-by-hour and day-of-week
  charts, top tools, and lifetime action counts (edits, commands, searches, file reads).
- **Application** (click any app) — its own KPIs, a **💬 query console** (ask Claude about
  the repo, runs headlessly read-only in that folder using your plan), activity chart,
  model mix, GitHub panel (commits, open PRs, CI), and per-session breakdown.
- **Approvals** — the **🛡️ Dashboard Approval Gateway** (approve/deny VS Code permission
  prompts from here — see below), a live feed of notifications + tool activity, and a
  manager for your `settings.json` allowlist (every edit backed up to `data/settings-backups/`).
- **Settings** — GitHub token, hook install, and **add applications** (local folders and/or
  GitHub repos beyond the auto-discovered ones).

## Two headline features

**Query an app directly.** On any application page, type a question in the 💬 console and
hit Run (or Ctrl/⌘+Enter). It launches the bundled Claude Code CLI **headlessly in that
app's folder in read-only (plan) mode**, streams the answer back live, and reports the
API-equivalent cost. Uses your existing Max/Pro auth — no API key needed.

**Approve VS Code prompts from the dashboard.** Turn the Approval Gateway **ON** (Approvals
screen). A blocking `PreToolUse` hook then routes Edit/Write/Bash tool calls to the
dashboard, where they appear under *Pending Approvals* with Approve / Deny buttons — so you
can clear permission prompts without switching to the VS Code window. If you don't respond
within ~50s, the normal VS Code prompt appears, so it can never wedge a session. Default
**OFF** (no behavior change until you enable it). Requires `node hooks/install.mjs`.

## How it works

| Piece | What it does |
|---|---|
| `server/sessions.js` | Parses `~/.claude/projects/*/*.jsonl`, sums per-model token usage, computes cost, detects live sessions (transcript touched < 10 min ago). |
| `server/pricing.js` | Per-model pricing (Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50; cache-write 1.25×, cache-read 0.1×). Edit to taste. |
| `server/github.js` | Maps each app's working dir → git remote → GitHub API metrics (cached 5 min). Falls back to local git stats with no token. |
| `server/approvals.js` | Reads the permission allowlist + the hook event log; edits the allowlist with backups. |
| `hooks/logger.mjs` | Claude Code hook that records permission/activity events. |
| `web/` | Vanilla SPA (dark glass + neon), hand-rolled SVG charts, polls every 5 s. |

Costs are estimates derived from transcript usage; treat them as directional.
The dashboard is read-only except for the allowlist editor and the GitHub token.

## Security

Vibe Center handles local data (your transcripts, a GitHub token, your permission
allowlist) and can run Claude in your repos, so it's locked down to your machine:

- **Loopback only.** The server binds to `127.0.0.1` — never exposed to your LAN.
- **DNS-rebinding protection.** Requests with a non-loopback `Host` header are rejected.
- **CSRF protection.** State-changing requests carrying a cross-origin `Origin` are rejected,
  so a malicious website open in your browser can't drive the API. (Local tools and the hook,
  which send no `Origin`, still work.)
- **No CORS.** Other origins can't read API responses.
- **Secrets never leave the box and never reach the browser.** The GitHub token lives only in
  `data/config.json` (gitignored); the API only ever returns whether a token is *set*, never its
  value. Only the non-secret plan type/tier is read from Claude credentials — never any token.
- **Query is sandboxed to known folders.** The 💬 console runs Claude in **read-only (plan) mode**
  and only in folders Vibe Center already tracks — never an arbitrary path. Prompts are passed as
  process arguments (no shell), so there's no command injection.
- **Hardened responses.** A strict `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  and `Referrer-Policy: no-referrer` are sent; static serving is path-traversal-guarded; model
  output is rendered as text, never HTML.
- **Allowlist edits are backed up** to `data/settings-backups/` before any change.

`data/` (token, event log, settings backups, the app-window browser profile) is gitignored, so
none of it can be committed.

## Project layout

```
server/      zero-dependency Node backend (metrics, GitHub, query, approvals, account)
web/         vanilla SPA (dark-glass/neon), hand-rolled SVG/CSS charts
hooks/       logger.mjs + gateway.mjs + install.mjs (Claude Code hooks)
vibecenter/  desktop launcher, icon generator, shortcut installer
data/        local state (gitignored)
```

## License

MIT © 2026 Jameson — see [LICENSE](LICENSE).
