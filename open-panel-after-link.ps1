$ErrorActionPreference = "Stop"

$AppRoot = $PSScriptRoot
$Launcher = Join-Path $AppRoot "UsagePanel.exe"
$SafeWorkingDirectory = [IO.Path]::GetTempPath()

if (-not (Test-Path $Launcher -PathType Leaf)) {
  throw "Usage Panel launcher is missing. Reinstall Usage Panel."
}
Start-Process -FilePath $Launcher -WorkingDirectory $SafeWorkingDirectory
