#!/usr/bin/env bash
# One-time macOS auto-start for Vibe Center. Installs two launchd agents that
# keep the local agent + connect bridge running on login (and relaunch them if
# they die), so this machine stays in your Fleet without keeping terminals open.
#
#   bash vibecenter/mac-autostart.sh <PAIR_TOKEN> <BROKER_URL>
#
# Get the token from the dashboard → Settings → Connect a machine.
set -euo pipefail

TOKEN="${1:-}"; BROKER="${2:-}"
if [ -z "$TOKEN" ] || [ -z "$BROKER" ]; then
  echo "Usage: bash vibecenter/mac-autostart.sh <PAIR_TOKEN> <BROKER_URL>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"; [ -n "$NODE" ] || NODE="/opt/homebrew/bin/node"
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
RUN="$ROOT/vibecenter/bridge-run.sh"
echo "Repo: $ROOT"
echo "node: $NODE"
[ -x "$NODE" ] || { echo "node not found — install it (brew install node) and re-run." >&2; exit 1; }

# Bridge runner: wait for the agent (+ its internal token) to be ready, then connect.
cat > "$RUN" <<EOF
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
cd "$ROOT"
for i in \$(seq 1 60); do
  [ -f "$ROOT/data/internal-token" ] && curl -s --max-time 1 http://localhost:7878/api/health >/dev/null 2>&1 && break
  sleep 1
done
exec "$NODE" broker/connect.mjs "$TOKEN" "$BROKER"
EOF
chmod +x "$RUN"

# Agent launchd job (the dashboard data for this machine).
cat > "$LA/com.vibecenter.agent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vibecenter.agent</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>server/server.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/vibecenter-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/vibecenter-agent.log</string>
</dict></plist>
EOF

# Bridge launchd job (connects this machine to the broker).
cat > "$LA/com.vibecenter.bridge.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vibecenter.bridge</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RUN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/vibecenter-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/vibecenter-bridge.log</string>
</dict></plist>
EOF

# (Re)load both — works whether or not they were already installed.
for L in com.vibecenter.agent com.vibecenter.bridge; do
  launchctl unload "$LA/$L.plist" 2>/dev/null || true
  launchctl load "$LA/$L.plist"
done

echo ""
echo "✓ Installed. The agent + bridge now start on login and stay connected."
echo "  Status:  launchctl list | grep vibecenter"
echo "  Logs:    /tmp/vibecenter-agent.log   /tmp/vibecenter-bridge.log"
echo "  Remove:  launchctl unload ~/Library/LaunchAgents/com.vibecenter.*.plist && rm ~/Library/LaunchAgents/com.vibecenter.*.plist"
