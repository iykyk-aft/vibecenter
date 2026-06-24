#!/usr/bin/env bash
# One-shot provisioner for the Vibe Center broker on a fresh Ubuntu/Debian VPS.
# IP-only, plain HTTP on port 80 (no domain / TLS). Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/.../provision.sh | sudo bash
#   # or copy this file to the box and:  sudo bash provision.sh
#
# It installs Node + Caddy, creates the deploy user, authorizes the deploy key,
# writes the systemd service + sudoers + Caddy reverse proxy, and opens the
# firewall. It does NOT fetch the app code — the GitHub Action rsyncs that on the
# first deploy (so this private repo needs no credentials on the box).
set -euo pipefail

DEPLOY_USER=vibecenter
APP_DIR=/opt/vibecenter
# Public half of the deploy key the GitHub Action uses to SSH in. Safe to embed.
DEPLOY_PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxf7E/Sz+1O2PopWC7Vq1cyzpZW0gV5alhB9N1bmVCM github-deploy-vibecenter'

[ "$(id -u)" -eq 0 ] || { echo "Run as root:  sudo bash provision.sh" >&2; exit 1; }

echo "==> Installing base packages (git, rsync, curl, ufw)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git rsync ufw apt-transport-https

echo "==> Installing Node.js 20 (if needed)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy (if needed)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Creating deploy user '$DEPLOY_USER' + authorizing deploy key"
id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEPLOY_USER"
install -d -m700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
grep -qF "$DEPLOY_PUBKEY" "/home/$DEPLOY_USER/.ssh/authorized_keys" || echo "$DEPLOY_PUBKEY" >> "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

echo "==> App directory $APP_DIR (populated by the first deploy)"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

echo "==> systemd service vibecenter-broker"
cat >/etc/systemd/system/vibecenter-broker.service <<UNIT
[Unit]
Description=Vibe Center broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$DEPLOY_USER
WorkingDirectory=$APP_DIR
Environment=BROKER_PORT=7900
Environment=BROKER_HOST=127.0.0.1
ExecStart=/usr/bin/node broker/broker.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable vibecenter-broker >/dev/null 2>&1 || true

echo "==> sudoers: passwordless restart for $DEPLOY_USER"
cat >/etc/sudoers.d/vibecenter-deploy <<SUDO
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart vibecenter-broker, /usr/bin/systemctl status vibecenter-broker
SUDO
chmod 440 /etc/sudoers.d/vibecenter-deploy

echo "==> Caddy reverse proxy (IP-only, plain HTTP on :80)"
cat >/etc/caddy/Caddyfile <<'CADDY'
# IP-only HTTP. To add HTTPS later: replace ":80" with "your.domain.com" and
# Caddy auto-provisions a Let's Encrypt cert (also open 443 in the firewall).
:80 {
	encode gzip
	reverse_proxy 127.0.0.1:7900 {
		flush_interval -1
	}
}
CADDY
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "==> Firewall: allow SSH + HTTP only"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<DONE

==================================================================
  Provision complete.  Public IP: ${IP:-<unknown>}

  Next (one time):
    1. Add these GitHub repo secrets (Settings -> Secrets -> Actions):
         DEPLOY_HOST   = ${IP:-<your VPS IP>}
         DEPLOY_USER   = $DEPLOY_USER
         DEPLOY_SSH_KEY= <the private deploy key>
    2. Push to main (or run the "Deploy broker" workflow).

  The Action rsyncs the code here, runs npm install, and starts the
  broker. It will then be reachable at:

         http://${IP:-<your VPS IP>}/

  NOTE: plain HTTP — login cookies are unencrypted. Add a domain +
  TLS (edit /etc/caddy/Caddyfile) before using it for real.
==================================================================
DONE
