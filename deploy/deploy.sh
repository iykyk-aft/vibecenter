#!/usr/bin/env bash
# Pull the latest main and restart the broker. Runs ON the VPS — invoked by the
# GitHub Action over SSH, or by hand. Idempotent and safe to re-run.
#
#   Usage:  deploy/deploy.sh            # uses APP_DIR or the script's repo root
#           APP_DIR=/opt/vibecenter deploy/deploy.sh
set -euo pipefail

# Where the checkout lives on the server. Defaults to the repo this script is in.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE="${DEPLOY_SERVICE:-vibecenter-broker}"

cd "$APP_DIR"
echo "==> Deploying $BRANCH in $APP_DIR"

# Fast-forward only: never clobber server-side commits, fail loudly if they exist.
git fetch --prune origin "$BRANCH"
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH"

# Install only if the lockfile/manifest moved since the last deploy.
if ! git diff --quiet HEAD@{1} HEAD -- package.json package-lock.json 2>/dev/null; then
  echo "==> Dependencies changed — installing"
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
else
  echo "==> No dependency changes — skipping install"
fi

# Restart the broker. Prefer systemd; fall back to pm2 if that's how it's run.
if command -v systemctl >/dev/null && systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  echo "==> Restarting systemd service: $SERVICE"
  sudo systemctl restart "$SERVICE"
  sudo systemctl --no-pager status "$SERVICE" | head -5
elif command -v pm2 >/dev/null; then
  echo "==> Restarting pm2 process: $SERVICE"
  pm2 restart "$SERVICE" --update-env || pm2 start broker/broker.js --name "$SERVICE"
  pm2 save
else
  echo "!! No systemd unit or pm2 found — start the broker manually (npm run broker)." >&2
  exit 1
fi

echo "==> Deploy complete: $(git rev-parse --short HEAD)"
