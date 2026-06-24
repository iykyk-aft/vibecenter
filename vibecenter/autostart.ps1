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
  Start-Process $node -ArgumentList 'broker/broker.js' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# 3) Connect bridge — reuse the owner's stored pairing token
$pairFile = Join-Path $root 'broker\data\pairings.json'
if (Test-Path $pairFile) {
  $token = (Get-Content $pairFile -Raw | ConvertFrom-Json).PSObject.Properties.Name | Select-Object -First 1
  if ($token) {
    $env:BROKER_URL = 'http://localhost:7900'
    Start-Process $node -ArgumentList "broker/connect.mjs $token" -WorkingDirectory $root -WindowStyle Hidden
  }
}
