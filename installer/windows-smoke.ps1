param(
  [string]$Version = "1.0.2"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Installer = Resolve-Path (Join-Path $Root "dist\UsagePanel-Setup-$Version.exe")
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Usage Panel"
$DesktopDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$ProgramsDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
$DesktopShortcutPath = Join-Path $DesktopDir "Usage Panel.lnk"
$StartMenuDir = Join-Path $ProgramsDir "Usage Panel"
$StartMenuShortcutPath = Join-Path $StartMenuDir "Usage Panel.lnk"
$LinkShortcutPath = Join-Path $StartMenuDir "Link this computer.lnk"
$EnrollmentDir = Join-Path $env:APPDATA "usage-panel"

function Wait-PanelReady {
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/sync" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  throw "Usage Panel did not become ready after launch."
}

function Wait-PanelStopped {
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/sync" -TimeoutSec 1 | Out-Null
    } catch { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Usage Panel did not stop between launch tests."
}

function Assert-Shortcut {
  param(
    [string]$Path,
    [string]$TargetLeaf,
    [string[]]$ArgumentFragments
  )
  if (-not (Test-Path $Path -PathType Leaf)) { throw "missing shortcut: $Path" }
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($Path)
    if ([IO.Path]::GetFileName($shortcut.TargetPath) -ine $TargetLeaf) {
      throw "unexpected shortcut target for ${Path}: $($shortcut.TargetPath)"
    }
    foreach ($fragment in $ArgumentFragments) {
      if ($shortcut.Arguments -notlike "*$fragment*") {
        throw "shortcut arguments for $Path did not contain: $fragment"
      }
    }
  } finally {
    if ($shortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

$install = Start-Process $Installer -ArgumentList "/S" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "installer exited $($install.ExitCode)" }

$required = @(
  (Join-Path $InstallDir "node\node.exe"),
  (Join-Path $InstallDir "open-panel.vbs"),
  (Join-Path $InstallDir "open-panel-after-link.ps1"),
  (Join-Path $InstallDir "enroll-panel.ps1"),
  $DesktopShortcutPath,
  $StartMenuShortcutPath,
  $LinkShortcutPath,
  (Join-Path $InstallDir "Uninstall.exe")
)
foreach ($path in $required) {
  if (-not (Test-Path $path)) { throw "missing after install: $path" }
}

Assert-Shortcut -Path $DesktopShortcutPath -TargetLeaf "wscript.exe" -ArgumentFragments @("open-panel.vbs")
Assert-Shortcut -Path $StartMenuShortcutPath -TargetLeaf "wscript.exe" -ArgumentFragments @("open-panel.vbs")
Assert-Shortcut -Path $LinkShortcutPath -TargetLeaf "powershell.exe" -ArgumentFragments @("enroll-panel.ps1", "-OpenPanelAfterLink")

& (Join-Path $InstallDir "node\node.exe") --version

# A harmless local marker skips the enrollment form so the real installed Desktop
# shortcut can exercise the launcher and dashboard readiness on the Windows runner.
New-Item $EnrollmentDir -ItemType Directory -Force | Out-Null
"{}" | Set-Content (Join-Path $EnrollmentDir "enrollment.json") -Encoding ascii
Start-Process $DesktopShortcutPath
Wait-PanelReady

# Stop the first launch, then invoke the exact helper used after a successful
# direct "Link this computer" enrollment and require the dashboard to return.
& (Join-Path $InstallDir "uninstall-helper.ps1")
Wait-PanelStopped
& (Join-Path $InstallDir "open-panel-after-link.ps1")
Wait-PanelReady

$Uninstaller = Join-Path $InstallDir "Uninstall.exe"
$uninstall = Start-Process $Uninstaller -ArgumentList "/S" -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "uninstaller exited $($uninstall.ExitCode)" }
if (Test-Path $InstallDir) { throw "install directory remained after uninstall" }
if (Test-Path $DesktopShortcutPath) { throw "Desktop shortcut remained after uninstall" }
if (Test-Path $StartMenuDir) { throw "Start Menu shortcuts remained after uninstall" }

Remove-Item $EnrollmentDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "installer_smoke=panel_launch_handoff_shortcuts_uninstall_ok"
