# Vibe Center auto-start: brings up the agent + LAN/Funnel broker + connect
# bridge, hidden, on logon. Idempotent — skips anything already running.
# (Tailscale Funnel itself is restored by the Tailscale service automatically.)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Full node path — the Task Scheduler context often lacks PATH entries.
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } else { $node = 'node' } }

function Running($port) { try { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop) } catch { $false } }

# 1) Agent (dashboard data) on 7878
if (-not (Running 7878)) {
  Start-Process $node -ArgumentList 'server/server.js' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# 2) Broker open to LAN + Funnel on 7900
if (-not (Running 7900)) {
  $env:BROKER_HOST = '0.0.0.0'; $env:BROKER_PORT = '7900'
  $env:BROKER_PUBLIC_URL = 'https://desktop-av0ghhf.tail26ff04.ts.net'
  Start-Process $node -ArgumentList 'broker/broker.js' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# 3) Connect bridge — reuse the owner's stored pairing token. Idempotent: the
# bridge holds no listening port, so detect it by command line instead.
$bridgeUp = $false
try {
  $bridgeUp = [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -match 'connect\.mjs' })
} catch { $bridgeUp = $false }
$pairFile = Join-Path $root 'broker\data\pairings.json'
if (-not $bridgeUp -and (Test-Path $pairFile)) {
  $token = (Get-Content $pairFile -Raw | ConvertFrom-Json).PSObject.Properties.Name | Select-Object -First 1
  if ($token) {
    $env:BROKER_URL = 'http://localhost:7900'
    Start-Process $node -ArgumentList "broker/connect.mjs $token" -WorkingDirectory $root -WindowStyle Hidden
  }
}

# 4) Tailnet-only HTTPS for the agent on 8443 — the iPad PWA path. HTTPS is
# required: iOS Safari will not register /sw.js outside a secure context.
# tailscaled restores this from its own ServeConfig on boot; we only re-assert
# it if a `serve reset` or state wipe removed it.
# NOTE: `serve` is tailnet-only. NEVER `funnel` 8443 — that would publish the agent.
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
  $up = $false
  for ($i = 0; $i -lt 20; $i++) {
    & $ts status --json 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $up = $true; break }
    Start-Sleep -Seconds 3
  }
  if ($up) {
    $needServe = $true
    try {
      $j = (& $ts serve status --json 2>$null | Out-String)
      if ($LASTEXITCODE -eq 0 -and $j.Trim()) {
        $cfg = $j | ConvertFrom-Json
        if ($cfg.TCP -and $cfg.TCP.PSObject.Properties.Name -contains '8443') { $needServe = $false }
      }
    } catch { $needServe = $true }
    if ($needServe) {
      & $ts serve --bg --https=8443 http://127.0.0.1:7878 1>$null 2>$null
      if ($LASTEXITCODE -ne 0) {
        Add-Content -Path (Join-Path $root 'data\autostart.log') -Value "$(Get-Date -Format s) tailscale serve --https=8443 failed (exit $LASTEXITCODE)"
      }
    }
  } else {
    Add-Content -Path (Join-Path $root 'data\autostart.log') -Value "$(Get-Date -Format s) tailscaled not ready; skipped serve 8443"
  }
}
