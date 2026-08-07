$ErrorActionPreference = "Stop"

$AppRoot = $PSScriptRoot
$Launcher = Join-Path $AppRoot "open-panel.vbs"
$Wscript = Join-Path $env:WINDIR "System32\wscript.exe"

if (-not (Test-Path $Launcher -PathType Leaf)) {
  throw "Usage Panel launcher is missing. Reinstall Usage Panel."
}
if (-not (Test-Path $Wscript -PathType Leaf)) {
  throw "Windows Script Host is unavailable."
}

Start-Process -FilePath $Wscript -ArgumentList ('"{0}"' -f $Launcher) -WorkingDirectory $AppRoot
