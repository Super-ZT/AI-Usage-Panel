$ErrorActionPreference = "SilentlyContinue"
$StopFile = Join-Path $PSScriptRoot ".usage-panel-stop"
"stop" | Set-Content $StopFile -Encoding ascii -NoNewline

Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.Id -Force }

$NodePath = (Join-Path $PSScriptRoot "node\node.exe").ToLowerInvariant()
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $NodePath -and
  $_.CommandLine -and $_.CommandLine -match "refresher\.js"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

function Get-UsagePanelLaunchers {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq "cmd.exe" -and $_.CommandLine -and
    $_.CommandLine.IndexOf($PSScriptRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine.IndexOf("start-panel.cmd", [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}

$launcher = @()
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  $launcher = Get-UsagePanelLaunchers
  if (-not $launcher) { break }
  Start-Sleep -Milliseconds 100
}
if ($launcher) {
  $launcher | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Milliseconds 200
}
