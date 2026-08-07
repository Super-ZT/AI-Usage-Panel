$ErrorActionPreference = "SilentlyContinue"
$StopFile = Join-Path $PSScriptRoot ".usage-panel-stop"
"stop" | Set-Content $StopFile -Encoding ascii -NoNewline

$NodePath = (Join-Path $PSScriptRoot "node\node.exe").ToLowerInvariant()
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $NodePath -and
  $_.CommandLine -and $_.CommandLine -match "refresher\.js"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$LauncherPattern = [regex]::Escape((Join-Path $PSScriptRoot "start-panel.cmd"))
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $launcher = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq "cmd.exe" -and $_.CommandLine -and
    $_.CommandLine -match $LauncherPattern
  }
  if (-not $launcher) { break }
  Start-Sleep -Milliseconds 100
}
