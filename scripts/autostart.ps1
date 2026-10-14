# Starts Colony when you sign in to Windows (scripts\run.ps1 keeps it running), so
# routines run and your phone can reach it.
#   Install:  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#   Remove:   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove
# Build first (npm run build). After pulling changes, rebuild and restart:
#   npm run build; powershell -ExecutionPolicy Bypass -File scripts\restart.ps1
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$taskName = "Colony"
$repo = Split-Path -Parent $PSScriptRoot

function Stop-Colony {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server*dist*index.js*' -and $_.CommandLine -like "*$repo*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

if ($Remove) {
  Stop-Colony
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Colony no longer starts at sign-in, and it has been stopped."
  return
}

if (-not (Test-Path (Join-Path $repo "server\dist\index.js")) -or -not (Test-Path (Join-Path $repo "web\dist\index.html"))) {
  throw "Build Colony first: npm run build"
}

$runner = Join-Path $repo "scripts\run.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Colony: your self-hosted team of AI Bots (scripts\run.ps1)" -Force | Out-Null

Write-Host "Colony will start when you sign in. Start it now with: Start-ScheduledTask -TaskName Colony"
