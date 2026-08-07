$ErrorActionPreference = "SilentlyContinue"
$NodePath = (Join-Path $PSScriptRoot "node\node.exe").ToLowerInvariant()
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $NodePath -and
  $_.CommandLine -and $_.CommandLine -match "refresher\.js"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
