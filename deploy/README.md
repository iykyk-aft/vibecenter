# Broker deployment

The broker (`broker/broker.js`) is the always-on cloud service. Pushing to
`main` redeploys it via [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):
the GitHub Action (which has private-repo read access) **rsyncs the code to the
VPS** and restarts the service, so the VPS itself needs no GitHub credentials.

## Quick start (IP-only, plain HTTP)

1. **On a fresh Ubuntu/Debian VPS**, run the provisioner as root. It installs
   Node + Caddy, creates the `vibecenter` user, authorizes the deploy key, and
   writes the systemd service, sudoers, Caddy reverse proxy (IP-only HTTP on
   :80), and firewall rules:
   ```bash
   sudo bash deploy/provision.sh
   ```
   (Copy `deploy/provision.sh` to the box, or `curl` it down.) It prints the
   public IP and the secrets to set next. It does **not** fetch the app code —
   the first deploy does that.

2. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `DEPLOY_HOST` | your VPS IP (printed by the provisioner) |
   | `DEPLOY_USER` | `vibecenter` |
   | `DEPLOY_SSH_KEY` | the **private** deploy key (its public half is baked into `provision.sh`) |
   | `DEPLOY_PORT` | SSH port — optional, defaults to `22` |
   | `DEPLOY_PATH` | checkout path — optional, defaults to `/opt/vibecenter` |

3. **Push to `main`** (or run the **Deploy broker** workflow manually). The
   Action rsyncs the code to `/opt/vibecenter`, runs `npm install`, and starts
   the broker. It's then reachable at `http://<your-ip>/`.

> ⚠️ **Plain HTTP** means login cookies travel unencrypted. Fine for testing
> from a trusted network; add TLS before real use (see below).

## Adding HTTPS later (a domain)

Point a domain's A record at the VPS, then edit `/etc/caddy/Caddyfile` to
replace the `:80` block with your hostname — Caddy auto-provisions a Let's
Encrypt cert:
```caddy
broker.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:7900 { flush_interval -1 }
}
```
```bash
sudo ufw allow 443/tcp
sudo systemctl reload caddy
```
An nginx + certbot alternative ships in [`deploy/nginx-vibecenter.conf`](./nginx-vibecenter.conf).

## How the pieces fit

- The broker binds to `127.0.0.1:7900` (`BROKER_HOST=127.0.0.1` in the unit), so
  the port is never exposed directly — Caddy on :80 is the only public surface.
- `provision.sh` enables the `vibecenter-broker` systemd service; it starts
  serving after the first deploy populates the code.
- The deploy excludes `broker/data` from rsync, so accounts/pairings on the box
  are never clobbered by a deploy.

## Manual deploy

The Action is the supported path. To re-apply by hand on the VPS after the code
is in place:
```bash
cd /opt/vibecenter && bash deploy/deploy.sh   # npm install + restart
```
