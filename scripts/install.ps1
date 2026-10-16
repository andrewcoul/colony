# Installs (or reinstalls) a Colony server on this PC and starts it whenever you sign in.
# After this, update Colony from the app: Settings -> Updates.
#
#   Latest release:
#     irm https://github.com/andrewcoul/colony/releases/latest/download/install-colony-server.ps1 | iex
#   With options:
#     & ([scriptblock]::Create((irm https://github.com/andrewcoul/colony/releases/latest/download/install-colony-server.ps1))) -DataDir D:\ColonyData
#   From a downloaded archive:
#     powershell -ExecutionPolicy Bypass -File install-colony-server.ps1 -Archive colony-server-0.1.0-win-x64.zip
#
# Options: -InstallDir (default %LOCALAPPDATA%\Colony), -DataDir (where Colony keeps your Bots;
# default <InstallDir>\data), -EnvFile (a .env to start from), -Version (a specific release),
# -NoStart (install without starting), -TaskName (default Colony).
param(
  [string]$Archive,
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Colony'),
  [string]$DataDir,
  [string]$EnvFile,
  [string]$Repo = 'andrewcoul/colony',
  [string]$TaskName = 'Colony',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Downloads crawl with the progress bar on in PowerShell 5.1.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object System.Text.UTF8Encoding $false # Node rejects a byte-order mark in JSON.
$platform = 'win-x64'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Colony needs Node.js 22.19 or newer. Install it (for example: winget install OpenJS.NodeJS.LTS), open a new PowerShell window, and run this again.'
}
$nodeVersion = [version](& node -p 'process.versions.node')
if ($nodeVersion -lt [version]'22.19.0') { throw "Colony needs Node.js 22.19 or newer; this PC has $nodeVersion. Update Node.js and run this again." }

New-Item -ItemType Directory -Force (Join-Path $InstallDir 'versions') | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ('colony-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$incoming = Join-Path $InstallDir 'versions\.incoming'

try {
  # 1. Get the archive (checked against the release's SHA256SUMS) and unpack it beside the others.
  if (-not $Archive) {
    $headers = @{ 'User-Agent' = 'colony-installer'; 'Accept' = 'application/vnd.github+json' }
    $endpoint = if ($Version) { "releases/tags/v$($Version.TrimStart('v'))" } else { 'releases/latest' }
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/$endpoint" -Headers $headers
    $asset = $release.assets | Where-Object { $_.name -like "colony-server-*-$platform.zip" } | Select-Object -First 1
    $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
    if (-not $asset -or -not $sums) { throw "Release $($release.tag_name) has no Colony server for Windows." }
    Write-Host "Downloading Colony $($release.tag_name)..."
    $Archive = Join-Path $work $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $Archive -UseBasicParsing
    Invoke-WebRequest $sums.browser_download_url -OutFile (Join-Path $work 'SHA256SUMS') -UseBasicParsing
    $line = Get-Content (Join-Path $work 'SHA256SUMS') | Where-Object { ($_ -split '\s+\*?')[1] -eq $asset.name } | Select-Object -First 1
    $actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower()
    if (-not $line -or ($line -split '\s+')[0].ToLower() -ne $actual) { throw "The download doesn't match the release's checksum, so it wasn't installed." }
  }
  $Archive = (Resolve-Path $Archive).Path
  if (Test-Path $incoming) { Remove-Item -Recurse -Force $incoming }
  New-Item -ItemType Directory $incoming | Out-Null
  & "$env:SystemRoot\System32\tar.exe" -xf $Archive -C $incoming
  if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $Archive." }
  $newVersion = ([IO.File]::ReadAllText((Join-Path $incoming 'package.json')) | ConvertFrom-Json).version
  if (-not $newVersion -or -not (Test-Path (Join-Path $incoming 'server\dist\index.js'))) { throw "$Archive isn't a Colony server archive." }

  # 2. Settings: .env (keys, ports, where your data lives).
  $envPath = Join-Path $InstallDir '.env'
  if (-not (Test-Path $envPath)) {
    $source = if ($EnvFile) { $EnvFile } else { Join-Path $incoming '.env.example' }
    Copy-Item $source $envPath
  }
  $envText = [IO.File]::ReadAllText($envPath)
  if ($DataDir) {
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    $line = "COLONY_DATA_DIR=$DataDir"
    if ($envText -match '(?m)^\s*#?\s*COLONY_DATA_DIR=.*$') { $envText = [regex]::Replace($envText, '(?m)^\s*#?\s*COLONY_DATA_DIR=.*$', $line.Replace('$', '$$'), 1) }
    else { $envText = $envText.TrimEnd() + "`r`n$line`r`n" }
    [IO.File]::WriteAllText($envPath, $envText, $utf8)
  }
  $setting = { param($name, $default) $m = [regex]::Match($envText, "(?m)^\s*$name=(.*)$"); if ($m.Success -and $m.Groups[1].Value.Trim()) { $m.Groups[1].Value.Trim() } else { $default } }
  $port = & $setting 'COLONY_PORT' '8787'
  $dataPath = & $setting 'COLONY_DATA_DIR' 'data'
  if (-not [IO.Path]::IsPathRooted($dataPath)) { $dataPath = Join-Path $InstallDir $dataPath }

  # 3. Stop the Colony that's running now, if any (an older install or a checkout's runner).
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $arguments = ($task.Actions | Select-Object -First 1).Arguments
    if ($arguments -match '-File\s+"([^"]+)"') {
      $runner = $Matches[1]
      Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -OperationTimeoutSec 20 |
        Where-Object { $_.CommandLine -like "*$runner*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 |
    Where-Object { $_.CommandLine -like "*$InstallDir\launcher.mjs*" -or $_.CommandLine -like "*$InstallDir\versions\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $pidFile = Join-Path $dataPath 'colony.pid'
  if (Test-Path $pidFile) {
    $running = Get-Process -Id ([int](Get-Content $pidFile -Raw)) -ErrorAction SilentlyContinue
    if ($running -and $running.ProcessName -eq 'node') { Stop-Process -Id $running.Id -Force }
  }

  # 4. Put the new version in place and make it current.
  $target = Join-Path $InstallDir "versions\$newVersion"
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Rename-Item $incoming $newVersion
  $stateFile = Join-Path $InstallDir 'state.json'
  $state = [ordered]@{ current = $newVersion; previous = $null; trial = $null; failed = $null; updated = $null }
  if (Test-Path $stateFile) {
    $old = [IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
    $state.previous = if ($old.current -and $old.current -ne $newVersion) { $old.current } else { $old.previous }
  }
  [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), $utf8)
  foreach ($file in 'launcher.mjs', 'service.ps1') { Copy-Item (Join-Path $target "scripts\$file") (Join-Path $InstallDir $file) -Force }

  # 5. Start at sign-in, and now.
  $service = Join-Path $InstallDir 'service.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$service`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Colony: your self-hosted team of AI Bots ($service)" -Force | Out-Null

  Write-Host "Installed Colony $newVersion in $InstallDir (data: $dataPath)."
  if ($NoStart) { Write-Host "Start it with: Start-ScheduledTask -TaskName $TaskName"; return }
  Start-Sleep -Milliseconds 500
  Start-ScheduledTask -TaskName $TaskName
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep 1
    try {
      $system = Invoke-RestMethod "http://127.0.0.1:$port/api/system" -TimeoutSec 3
      if ($system.version -eq $newVersion) {
        Write-Host "Colony $newVersion is running: http://127.0.0.1:$port"
        Write-Host 'Open it, tap the gear, and add a model provider. Docker Desktop gives Bots their own computers; Tailscale reaches Colony from your phone (see the README).'
        return
      }
    } catch { }
  }
  Write-Host "Colony didn't answer within a minute; see $InstallDir\logs\colony.log."
  exit 1
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  if (Test-Path $incoming) { Remove-Item -Recurse -Force $incoming -ErrorAction SilentlyContinue }
}
