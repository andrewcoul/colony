# Restarts the always-on Colony (after `npm run build`), and waits until it answers.
#   powershell -ExecutionPolicy Bypass -File scripts\restart.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$port = if ($env:COLONY_PORT) { $env:COLONY_PORT } else { 8787 }

Stop-ScheduledTask -TaskName Colony -ErrorAction SilentlyContinue
# The task's runner and the server it started can outlive Stop-ScheduledTask; end both.
Get-CimInstance Win32_Process -OperationTimeoutSec 20 |
  Where-Object {
    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*scripts\run.ps1*' -and $_.CommandLine -like "*$repo*") -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*server*dist*index.js*' -and $_.CommandLine -like "*$repo*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Milliseconds 500
Start-ScheduledTask -TaskName Colony

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/state" -TimeoutSec 3
    if ($response.StatusCode -eq 200) { Write-Host "Colony is up on port $port."; exit 0 }
  } catch { }
}
Write-Host "Colony didn't come up within 30 seconds; see data\colony.log."
exit 1
