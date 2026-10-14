# Starts Colony automatically when you sign in to Windows, so routines keep running.
#   Install:  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#   Remove:   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove
# Build first (npm run build). Output goes to data\colony.log.
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$taskName = "Colony"
$repo = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the Colony sign-in task. Stop a running Colony with Task Manager or by closing its node process."
  return
}

if (-not (Test-Path (Join-Path $repo "server\dist\index.js")) -or -not (Test-Path (Join-Path $repo "web\dist\index.html"))) {
  throw "Build Colony first: npm run build"
}
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $repo "data") | Out-Null

# A hidden PowerShell runs `npm start` from the repo and appends to data\colony.log.
$command = "Set-Location -LiteralPath '$repo'; & '$npm' start *>> (Join-Path '$repo' 'data\colony.log')"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Colony: your self-hosted team of AI Bots" -Force | Out-Null

Write-Host "Colony will start when you sign in. Start it now with: Start-ScheduledTask -TaskName Colony"
