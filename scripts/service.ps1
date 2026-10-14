# Keeps an installed Colony running (install.ps1 sets it to start when you sign in). It makes
# sure Docker Desktop is starting (Bot computers need it; the rest of Colony doesn't), then
# runs launcher.mjs, which runs the current version and handles updates. Output goes to
# logs\colony.log in the install folder.
$ErrorActionPreference = 'Continue'
$colonyHome = $PSScriptRoot
Set-Location $colonyHome
New-Item -ItemType Directory -Force (Join-Path $colonyHome 'logs') | Out-Null
$log = Join-Path $colonyHome 'logs\colony.log'

# Only one runner at a time (shared with a checkout's scripts\run.ps1).
$mutex = New-Object System.Threading.Mutex($false, 'Local\ColonyRunner')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Write-Log($text) {
  for ($i = 0; $i -lt 5; $i++) {
    try { [System.IO.File]::AppendAllText($log, "$(Get-Date -Format s) $text`r`n"); return } catch { Start-Sleep -Milliseconds 200 }
  }
}

# A stray Ctrl+C sent to this hidden console would end the loop along with Colony.
Add-Type -Namespace Native -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
'@
[Native.Console]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null

# Stopping the task doesn't stop what it started; clear any leftover launcher or server.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 |
  Where-Object { $_.CommandLine -like "*$colonyHome\launcher.mjs*" -or $_.CommandLine -like "*$colonyHome\versions\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  $docker = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $docker) { Start-Process $docker }
}

while ($true) {
  # Keep one previous log; start fresh past 5 MB.
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.1" -Force -ErrorAction SilentlyContinue }
  # cmd does the redirection: PowerShell 5.1 would wrap each stderr line in an error record.
  cmd /c "node `"$colonyHome\launcher.mjs`" >> `"$log`" 2>&1"
  Write-Log "The launcher exited with code $LASTEXITCODE. Starting it again in 10 seconds."
  Start-Sleep 10
}
