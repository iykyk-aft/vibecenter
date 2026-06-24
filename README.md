# ⚡ Vibe Center

**Mission control for Claude Code.** A local-first desktop dashboard that tracks every Claude Code
app on your machine, runs and manages live coding sessions, approves permission prompts, scaffolds
new projects, and — optionally — lets you reach your machine securely from any device.

Reads your existing `~/.claude/projects/` transcripts. **Zero npm dependencies** (pure Node ≥18 +
vanilla JS). No build step, no telemetry, nothing leaves your machine unless you turn on remote access.

---

## Table of contents

- [Quick start](#quick-start)
- [Run it as a desktop app](#run-it-as-a-desktop-app)
- [Accounts & login](#accounts--login)
- [The screens](#the-screens)
- [Headline capabilities](#headline-capabilities)
  - [Multi-session Workbench](#1-multi-session-workbench)
  - [Run & query your apps](#2-run--query-your-apps)
  - [Approval gateway](#3-approval-gateway)
  - [End any session](#4-end-any-session)
  - [Create & add applications](#5-create--add-applications)
  - [Analytics & charts](#6-analytics--charts)
  - [Remote access (multi-user broker)](#7-remote-access-multi-user-broker)
  - [Auto-update & restart](#8-auto-update--restart)
- [Optional setup](#optional-setup)
- [How it works](#how-it-works)
- [Security](#security)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [License](#license)

---

## Quick start

```bash
cd claudeCommandCenter
npm start            # → http://localhost:7878
```

Metrics work immediately by parsing your local Claude Code transcripts. No `npm install`, no build.
Open the URL, create your owner account (first run), and you're in.

## Run it as a desktop app

```bash
npm run setup        # one-time: generates the ⚡ icon + Start Menu / Desktop shortcuts
npm run app          # or launch "Vibe Center" from the Start Menu / desktop
```

Launches in its own **chromeless window** (no tabs or address bar) via Chrome / Edge / Brave `--app`
mode — a real desktop app. It starts the server hidden if it isn't already running, and re-launching
reuses the running server. Assets are served `no-store`, so the window always reflects the latest UI.

---

## Accounts & login

Vibe Center is account-gated so it's safe to expose beyond your machine.

- **Owner account** — on first run you create an email + password login (passwords are **scrypt-hashed**;
  sessions last 30 days). The dashboard is locked behind it.
- **Invite-gated signups** — the first account is the owner; everyone after needs a **single-use invite
  code** you generate in **Settings → Invite Codes**.
- **Loopback stays frictionless** — the local Claude hooks talk to the server over `127.0.0.1` without a
  login, so installing the gateway never breaks.

---

## The screens

| Screen | What it gives you |
|---|---|
| **Overview** | Top-line KPIs (spend / API-equiv value, billable tokens, live sessions, tool calls), 30-day token activity, **model usage over time**, per-app **sparklines**, and a ranked, clickable list of every application. |
| **Fleet** | Every app across **all your connected machines** in one place (when using the broker). |
| **Workbench** | Run **many Claude Code sessions at once** — a session rail with live status + a focused conversation. See [below](#1-multi-session-workbench). |
| **Account** | Lifetime totals, rolling **5-hour usage window**, budgets, **spend pace + month-end projection**, token composition & **cache efficiency**, **cache savings**, an **activity heatmap**, by-hour / by-day charts, **session-size distribution**, cumulative tokens, and top tools. |
| **Approvals** | The **approval gateway** toggle, global "always allow", a live activity feed, pending approvals, and your `settings.json` allowlist manager. |
| **Settings** | GitHub token, usage budgets, invite codes, applications, connected machines, and the hook installer. |
| **Application page** | Per-app KPIs, a quick **read-only query console**, a **writeable session launcher**, per-workspace **approval mode**, GitHub metrics (stars / PRs / issues), token & model charts, running sessions, and a full session list you can open, continue, or **end**. |

Vibe Center is **plan-aware**: on a Pro/Max subscription the dollar figures are the *metered-API
equivalent* of your token usage (what it would cost on the API) — **not money charged**. Your real
cost is the flat subscription fee; you're limited by rate limits, not dollars.

---

## Headline capabilities

### 1. Multi-session Workbench

Run and supervise **many Claude Code sessions in parallel**, each in its own app, from one screen.

- **Session rail** with a live **status dot** per session — ⚪ idle · 🔵 working · 🟠 needs approval ·
  🟢 done · 🔴 error — plus an unread mark when a background session needs you.
- **Layouts:** Focus (one at a time), Split (two columns), or Grid (tile them all); maximize any pane.
- **Persistent:** sessions keep streaming when you switch views and survive a reload (stored locally) —
  they only go away when you close them.
- **Plan / Write** toggle per session, plus a per-workspace **🛡️ Auto-approve / Ask-each** toggle right
  in the header.
- **Claude-Code-style output:** each tool call renders as `⏺ Tool(args)` with collapsible command output,
  interleaved with the assistant's text — just like the CLI.
- **Stop / End / End all** controls.

### 2. Run & query your apps

Launch the bundled Claude Code CLI in any tracked repo, using your existing Max/Pro auth (no API key):

- **Quick query** — ask a question about a repo; runs **read-only (plan mode)** and streams the answer.
- **Writeable sessions** — let Claude actually edit and run commands, with every `Edit` / `Write` / `Bash`
  **gated by the approval gateway**.
- Fresh sessions capture their session id so you can **continue** them across turns, and you can reopen
  and continue any historical session from its transcript.

### 3. Approval gateway

Approve Claude's permission prompts **from the dashboard** instead of switching to VS Code.

- A blocking `PreToolUse` hook routes Edit / Write / Bash to Vibe Center for an **Approve / Deny** decision.
- **Per-workspace modes:** *Manual* (ask each time), *Always allow this workspace*, or *Always allow
  everything* (global). Path matching is case/slash-insensitive, so a workspace set to auto stays auto.
- **In-app prompts** pop up on **any screen** (not just the Approvals tab) so a running Workbench session
  never stalls waiting for you — with one-click Allow / Always-this-app / Always-all / Deny.
- **Allowlist manager** for your `settings.json` rules (every edit backed up first).
- If you don't respond in time, the normal VS Code prompt still appears — it can never wedge a session.
- Default **OFF**; nothing changes until you enable it and run `node hooks/install.mjs`.

### 4. End any session

Stop sessions you no longer want — wherever they came from.

- **Dashboard-launched sessions** (Workbench / query console) are tracked server-side and ended by id or
  per-application (the `claude` child is killed).
- **External VS Code / terminal sessions** can be ended too: the logger hook captures each session's
  `claude.exe` process, and the dashboard verifies and kills it (with PID-reuse guards). Available as an
  **⏹ End** button on live sessions on each application page.

### 5. Create & add applications

From the **➕ Add application** popup (sidebar or Overview — no Settings detour):

- **New project** — names a folder under your projects root, runs `git init`, optionally creates a **GitHub
  repo** (via the `gh` CLI) and pushes, then drops you straight into a **writeable session**.
- **Add existing** — register any local folder and/or GitHub repo so Vibe Center tracks it.

Apps are also **auto-discovered** from your Claude Code history.

### 6. Analytics & charts

Hand-rolled, dependency-free, **interactive** SVG charts built for understanding AI usage:

- **Interactive area chart** — hover crosshair + tooltip (value, day-over-day Δ), gridlines, average line,
  peak & latest markers. Reused across Overview / Account / app pages.
- **Model usage over time** — stacked area of tokens per model with a per-day breakdown.
- **Per-app sparklines**, **activity heatmap** (day × hour), by-hour / by-day-of-week bars.
- **Spend pace** — month-to-date cost with an end-of-month projection.
- **Token composition & cache efficiency**, plus **cache savings** (what prompt caching saved you).
- **Session-size distribution** histogram, cumulative tokens, top tools.

### 7. Remote access (multi-user broker)

Reach your dashboard from **any device** while your machine stays the backend — and host it for **multiple
users**, each on their own machine with their own Claude.

```
[ Browser / desktop app ]  →  [ Broker: accounts + routing ]  ⇄ outbound SSE ⇄  [ Your machine's agent ]
        anywhere                     always-on (your VPS)                         data + Claude stay home
```

- The **broker** (`broker/broker.js`, deploy on a VPS) owns accounts + invites, serves the website, and
  **reverse-proxies each logged-in user to their own machine** over an **outbound** tunnel — so users never
  port-forward.
- The **connect bridge** (`broker/connect.mjs`) runs on each user's machine, relaying broker requests to the
  local agent over loopback. Pair a machine with a one-time token; one account can connect **multiple
  machines** (see them all in **Fleet**).
- Your transcripts and Claude process never leave your machine — the broker only routes.
- `deploy/` contains a systemd unit + deploy script + GitHub Action for the broker.

> Prefer a private setup over a public URL? Point the broker behind Tailscale, or just keep everything
> loopback-only (the default) and skip the broker entirely.

### 8. Auto-update & restart

When the code changes on disk, the window shows a **"✨ New version ready · 🔄 Restart & update"** banner.
One click restarts the agent (a detached helper waits for the port to free, then starts a fresh server) and
reloads into the new build — so **server-code** updates take effect, not just UI tweaks.

---

## Optional setup

**GitHub metrics** (stars, PRs, issues, CI):
1. Create a token — classic with `repo`, or fine-grained with *repo → contents/metadata read*. To also let
   **New project** create repos, install the [`gh` CLI](https://cli.github.com/) and run `gh auth login`.
2. **Settings → GitHub** → paste → Save (stored in `data/config.json`, or set `GITHUB_TOKEN`).

**Live approvals / activity feed:**
```bash
node hooks/install.mjs              # wires Notification + PreToolUse hooks into ~/.claude/settings.json (backed up)
node hooks/install.mjs --uninstall  # remove later
```
Restart running Claude Code sessions afterward, then enable the gateway on the **Approvals** screen.

---

## How it works

| Piece | What it does |
|---|---|
| `server/server.js` | HTTP API + static host; auth gate, approval gateway state, run registry, restart. |
| `server/sessions.js` | Parses `~/.claude/projects/*/*.jsonl` (mtime-cached), sums per-model token usage, computes cost, detects live sessions, builds daily/heatmap aggregates. |
| `server/pricing.js` | Per-model pricing (Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50; cache-write 1.25×, cache-read 0.1×). Edit to taste. |
| `server/claude.js` | Spawns the Claude Code CLI headlessly, streams `stream-json` events (text, tool calls + output, cost). |
| `server/scaffold.js` | New-project scaffolding + `gh` repo creation. |
| `server/github.js` | Working dir → git remote → GitHub API metrics (cached). Falls back to local git with no token. |
| `server/auth.js` | Email+password accounts (scrypt), sessions, invite codes. |
| `server/approvals.js` / `server/apps.js` | Allowlist + event log; custom-app registry. |
| `hooks/` | `logger.mjs` (activity feed + session-PID capture), `gateway.mjs` (approval gateway), `install.mjs` (wires them into settings.json). |
| `broker/` | Cloud relay + per-machine connect bridge for remote, multi-user access. |
| `web/` | Vanilla SPA (dark glass + neon), hand-rolled interactive SVG charts, polling + live streams. |

Costs are estimates derived from transcript usage — treat them as directional.

---

## Security

Vibe Center handles local data (transcripts, a GitHub token, your permission allowlist) and can run Claude
in your repos, so it's locked down:

- **Loopback only & account-gated.** The agent binds to `127.0.0.1`; every data/control endpoint requires a
  session once an owner exists (the local hook endpoints are the only loopback exemptions).
- **DNS-rebinding & CSRF protection.** Non-loopback `Host` headers and cross-origin `Origin`s are rejected.
- **Secrets never reach the browser.** The GitHub token and password hashes live only under `data/`
  (gitignored); the API only reports whether a token is *set*.
- **Sandboxed runs.** Claude only runs in folders Vibe Center already tracks; prompts are passed as process
  args (no shell) — no command injection.
- **Approval guardrails.** Writeable sessions route Edit/Write/Bash through the gateway; ending a session
  verifies the target is really a `claude` process before killing it.
- **Hardened responses.** Strict CSP, `nosniff`, `no-referrer`; path-traversal-guarded static serving; model
  output rendered as text, never HTML. Allowlist edits are backed up first.

When you opt into the **broker**, it becomes the auth authority for remote requests, and each account is
isolated to its own machine(s).

---

## Project layout

```
server/      zero-dependency Node backend (metrics, query, approvals, auth, scaffold, account)
web/         vanilla SPA (dark-glass/neon), hand-rolled interactive SVG charts
hooks/       logger.mjs + gateway.mjs + install.mjs (Claude Code hooks)
broker/      cloud relay (broker.js) + per-machine connect bridge (connect.mjs)
vibecenter/  desktop launcher, restart helper, icon generator, shortcut installer
deploy/      broker systemd unit + deploy script + CI
data/        local state — accounts, token, config, event log, session PIDs (gitignored)
```

## Scripts

| Command | Does |
|---|---|
| `npm start` | Run the agent server → http://localhost:7878 |
| `npm run app` | Launch the chromeless desktop window |
| `npm run dev` | Server with `--watch` auto-reload |
| `npm run setup` | Generate icon + Start Menu / Desktop shortcuts (Windows) |
| `npm run broker` | Run the cloud broker (for remote/multi-user) |
| `npm run connect <token>` | Connect this machine to a broker |

## License

MIT © 2026 Jameson — see [LICENSE](LICENSE).
