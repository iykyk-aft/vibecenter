# Broker deployment

The broker (`broker/broker.js`) is the always-on cloud service. Pushing to
`main` redeploys it to the VPS automatically via
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

## One-time VPS setup

1. Clone the repo to the deploy path (default `/opt/vibecenter`):
   ```bash
   sudo git clone https://github.com/iykyk-aft/vibecenter.git /opt/vibecenter
   sudo chown -R vibecenter:vibecenter /opt/vibecenter
   ```
2. Install the systemd unit and start it:
   ```bash
   sudo cp /opt/vibecenter/deploy/vibecenter-broker.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now vibecenter-broker
   ```
   (Edit `User`, `WorkingDirectory`, and `Environment` in the unit first if your
   box differs. If you run the broker under **pm2** instead, name the process
   `vibecenter-broker` and `deploy.sh` will restart it automatically.)
3. Give the GitHub deploy user passwordless restart rights, e.g. in
   `sudo visudo`:
   ```
   vibecenter ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart vibecenter-broker, /usr/bin/systemctl status vibecenter-broker
   ```

## Reverse proxy + HTTPS

The systemd unit binds the broker to `127.0.0.1:7900` (`BROKER_HOST=127.0.0.1`),
so it is **not** reachable from the internet directly — a reverse proxy
terminates TLS and forwards to it. Pick one:

- **Caddy (simplest, auto-HTTPS):** [`deploy/Caddyfile`](./Caddyfile)
  ```bash
  sudo apt install -y caddy
  sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit broker.example.com first
  sudo systemctl reload caddy
  ```
- **nginx + Let's Encrypt (certbot):** [`deploy/nginx-vibecenter.conf`](./nginx-vibecenter.conf)
  ```bash
  sudo cp deploy/nginx-vibecenter.conf /etc/nginx/sites-available/vibecenter
  sudo ln -s /etc/nginx/sites-available/vibecenter /etc/nginx/sites-enabled/
  sudo apt install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d broker.example.com      # provisions cert + 443 + redirect
  sudo nginx -t && sudo systemctl reload nginx
  ```

Both are tuned for the broker's SSE streaming (no response buffering, long
timeouts) so live agent output isn't cut off.

### Firewall

Expose only 80/443 (and SSH); keep 7900 private:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

## GitHub repository secrets

Set these under **Settings → Secrets and variables → Actions**:

| Secret | Purpose | Example |
| --- | --- | --- |
| `DEPLOY_HOST` | VPS hostname or IP | `203.0.113.10` |
| `DEPLOY_USER` | SSH user that owns the checkout | `vibecenter` |
| `DEPLOY_SSH_KEY` | Private key whose public half is in the user's `authorized_keys` | (full PEM) |
| `DEPLOY_PORT` | SSH port (optional, defaults to 22) | `22` |
| `DEPLOY_PATH` | Checkout path (optional, defaults to `/opt/vibecenter`) | `/opt/vibecenter` |

Generate a dedicated key (don't reuse a personal one):
```bash
ssh-keygen -t ed25519 -f vibecenter-deploy -C "github-deploy"
# add vibecenter-deploy.pub to ~vibecenter/.ssh/authorized_keys on the VPS
# paste the private vibecenter-deploy into the DEPLOY_SSH_KEY secret
```

## Manual deploy

From the VPS, any time:
```bash
cd /opt/vibecenter && bash deploy/deploy.sh
```
Or trigger the workflow by hand from the Actions tab (**Run workflow**).
