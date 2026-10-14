# Keeps Colony running on this PC: makes sure Docker Desktop is starting (Bot computers
# need it, the rest of Colony doesn't), runs the built server, and restarts it if it exits.
# Output goes to data\colony.log. Register it to start at sign-in with scripts\autostart.ps1;
# restart it (after `npm run build`) with scripts\restart.ps1.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot)
$repo = (Get-Location).Path
New-Item -ItemType Directory -Force data | Out-Null
$log = Join-Path $repo 'data\colony.log'

# Only one runner at a time: two would fight over the server and the log.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ColonyRunner')
if (-not $mutex.WaitOne(0)) { exit 0 }

# Never let logging block or stop the loop (the server's own output may hold the file briefly).
function Write-Log($text) {
  for ($i = 0; $i -lt 5; $i++) {
    try { [System.IO.File]::AppendAllText($log, "$(Get-Date -Format s) $text`r`n"); return } catch { Start-Sleep -Milliseconds 200 }
  }
}

# A stray Ctrl+C sent to this hidden console would kill this loop along with Colony,
# leaving nothing to restart it. Ignore it here and in the processes started from here.
Add-Type -Namespace Native -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
'@
[Native.Console]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null

# Stopping the task doesn't stop the server it started; clear any leftover copy.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 |
  Where-Object { $_.CommandLine -like '*server*dist*index.js*' -and $_.CommandLine -like "*$repo*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  $docker = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $docker) { Start-Process $docker }
}

while ($true) {
  # Keep one previous log; start fresh past 5 MB.
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.1" -Force -ErrorAction SilentlyContinue }
  Write-Log 'Starting Colony.'
  # cmd does the redirection: PowerShell 5.1 would wrap each stderr line in an error record.
  cmd /c "node --env-file-if-exists=.env `"$repo\server\dist\index.js`" >> `"$log`" 2>&1"
  Write-Log "Colony exited with code $LASTEXITCODE. Restarting in 10 seconds."
  Start-Sleep 10
}
