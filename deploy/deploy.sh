#!/usr/bin/env bash
# Apply an already-synced checkout: (re)install prod deps and restart the broker.
# The GitHub Action rsyncs the code to the VPS, then runs this. You can also run
# it by hand on the box after updating the files. Idempotent and safe to re-run.
#
#   Usage:  APP_DIR=/opt/vibecenter deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE="${DEPLOY_SERVICE:-vibecenter-broker}"

cd "$APP_DIR"
echo "==> Installing production dependencies in $APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

echo "==> Restarting $SERVICE"
if command -v systemctl >/dev/null && systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  sudo systemctl restart "$SERVICE"
  sudo systemctl --no-pager status "$SERVICE" | head -5
elif command -v pm2 >/dev/null; then
  pm2 restart "$SERVICE" --update-env || pm2 start broker/broker.js --name "$SERVICE"
  pm2 save
else
  echo "!! No systemd unit or pm2 found — start the broker manually (npm run broker)." >&2
  exit 1
fi

echo "==> Deploy complete"
