# Creates Start Menu + Desktop shortcuts that launch Vibe Center as a desktop app.
$root = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $PSScriptRoot 'VibeCenter.vbs'
$icon = Join-Path $root 'web\assets\vibe.ico'

$W = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop'))  'Vibe Center.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Vibe Center.lnk')
)
foreach ($t in $targets) {
  $sc = $W.CreateShortcut($t)
  $sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $sc.Arguments = '"' + $vbs + '"'
  $sc.WorkingDirectory = $root
  if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Description = 'Vibe Center — Claude Code dashboard'
  $sc.WindowStyle = 7
  $sc.Save()
  Write-Output "Shortcut: $t"
}
