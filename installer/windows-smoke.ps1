param(
  [string]$Version = "1.0.3",
  [string]$BaselineInstaller = ""
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
$DiagnosticDir = Join-Path $env:LOCALAPPDATA "UsagePanel"
$DiagnosticFile = Join-Path $DiagnosticDir "launcher.log"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UsagePanelWindowCheck {
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr handle);
}
"@

function Wait-PanelReady {
  for ($attempt = 0; $attempt -lt 75; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/sync" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  throw "Usage Panel did not become ready after launch."
}

function Wait-PanelStopped {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/sync" -TimeoutSec 1 | Out-Null
    } catch { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Usage Panel did not stop between launch tests."
}

function Wait-VisibleWindow {
  param([string]$Title = "Usage Panel", [int]$Attempts = 100)
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $candidate = Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Refresh()
        $_.MainWindowHandle -ne 0 -and
          [UsagePanelWindowCheck]::IsWindowVisible($_.MainWindowHandle) -and
          $_.MainWindowTitle -eq $Title
      } | Select-Object -First 1
    if ($candidate) { return $candidate }
    Start-Sleep -Milliseconds 500
  }
  throw "Usage Panel did not create the expected visible top-level window: $Title"
}

function Wait-DiagnosticStatus {
  param([string]$Status)
  for ($attempt = 0; $attempt -lt 75; $attempt++) {
    if (Test-Path $DiagnosticFile) {
      $lines = Get-Content $DiagnosticFile
      if ($lines -match " $Status$") { return }
    }
    Start-Sleep -Milliseconds 400
  }
  throw "Usage Panel did not record expected diagnostic status: $Status"
}

function Wait-PathRemoved {
  param([string]$Path)
  for ($attempt = 0; $attempt -lt 75; $attempt++) {
    if (-not (Test-Path $Path)) { return }
    Start-Sleep -Milliseconds 200
  }
}

function Read-Shortcut {
  param([string]$Path)
  if (-not (Test-Path $Path -PathType Leaf)) { throw "missing shortcut" }
  $shell = New-Object -ComObject WScript.Shell
  try { return $shell.CreateShortcut($Path) }
  finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Assert-Shortcut {
  param([string]$Path, [string]$TargetLeaf, [string[]]$ArgumentFragments)
  $shortcut = Read-Shortcut -Path $Path
  try {
    if ([IO.Path]::GetFileName($shortcut.TargetPath) -ine $TargetLeaf) {
      throw "unexpected shortcut target"
    }
    foreach ($fragment in $ArgumentFragments) {
      if ($shortcut.Arguments -notlike "*$fragment*") { throw "unexpected shortcut arguments" }
    }
  } finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  }
}

function Invoke-Uninstall {
  $uninstaller = Join-Path $InstallDir "Uninstall.exe"
  if (Test-Path $uninstaller) {
    $result = Start-Process $uninstaller -ArgumentList "/S" -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "uninstaller exited $($result.ExitCode)" }
    Wait-PathRemoved -Path $InstallDir
  }
}

New-Item $EnrollmentDir -ItemType Directory -Force | Out-Null
"{}" | Set-Content (Join-Path $EnrollmentDir "enrollment.json") -Encoding ascii

if ($BaselineInstaller) {
  $baseline = Resolve-Path $BaselineInstaller
  $baselineHash = (Get-FileHash $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($baselineHash -ne "991800b7d5e20374a6014254fb45d2ba9b6e2ea44b1115e5b6c05bc19875598e") {
    throw "public v1.0.2 baseline checksum changed"
  }
  $installBaseline = Start-Process $baseline -ArgumentList "/S" -Wait -PassThru
  if ($installBaseline.ExitCode -ne 0) { throw "baseline installer exited $($installBaseline.ExitCode)" }
  $baselineShortcut = Read-Shortcut -Path $DesktopShortcutPath
  try {
    if ([IO.Path]::GetFileName($baselineShortcut.TargetPath) -ine "wscript.exe") {
      throw "public v1.0.2 baseline did not install its hidden script launcher"
    }
  } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($baselineShortcut) }
  if (Test-Path (Join-Path $InstallDir "UsagePanel.exe")) {
    throw "public v1.0.2 unexpectedly contained a visible application host"
  }
  Start-Process $DesktopShortcutPath
  Start-Sleep -Seconds 5
  if (Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue) {
    throw "public v1.0.2 unexpectedly created the native visible app"
  }
  Write-Host "baseline_v102_silent_launcher_reproduced=shortcut_target_wscript_no_native_window"
  Invoke-Uninstall
}

# Reproduce an upgrade residue before installing the candidate. The installer
# must clear this marker rather than letting its server child exit silently.
New-Item $InstallDir -ItemType Directory -Force | Out-Null
"stop" | Set-Content (Join-Path $InstallDir ".usage-panel-stop") -Encoding ascii -NoNewline
Remove-Item $DiagnosticDir -Recurse -Force -ErrorAction SilentlyContinue

$install = Start-Process $Installer -ArgumentList "/S" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "installer exited $($install.ExitCode)" }
if (Test-Path (Join-Path $InstallDir ".usage-panel-stop")) { throw "stale shutdown marker survived install" }

$required = @(
  (Join-Path $InstallDir "UsagePanel.exe"),
  (Join-Path $InstallDir "node\node.exe"),
  (Join-Path $InstallDir "open-panel-after-link.ps1"),
  (Join-Path $InstallDir "enroll-panel.ps1"),
  $DesktopShortcutPath,
  $StartMenuShortcutPath,
  $LinkShortcutPath,
  (Join-Path $InstallDir "Uninstall.exe")
)
foreach ($path in $required) { if (-not (Test-Path $path)) { throw "missing after install" } }

Assert-Shortcut -Path $DesktopShortcutPath -TargetLeaf "UsagePanel.exe" -ArgumentFragments @()
Assert-Shortcut -Path $StartMenuShortcutPath -TargetLeaf "UsagePanel.exe" -ArgumentFragments @()
Assert-Shortcut -Path $LinkShortcutPath -TargetLeaf "powershell.exe" -ArgumentFragments @("enroll-panel.ps1", "-OpenPanelAfterLink")

& (Join-Path $InstallDir "node\node.exe") --version

# Use the installed Desktop shortcut through the Windows shell, exactly as a
# customer's double-click does, and require a visible owned window plus HTTP.
Start-Process $DesktopShortcutPath
$visible = Wait-VisibleWindow
Wait-PanelReady
Wait-DiagnosticStatus -Status "WEBVIEW_READY"
Write-Host "visible_window_ok=title:$($visible.MainWindowTitle):handle_nonzero:true"

# A server child that exits must leave a visible plain-English failure instead
# of disappearing like v1.0.2. No dynamic exception, path, or identity is logged.
& (Join-Path $InstallDir "uninstall-helper.ps1")
Wait-PanelStopped
$refresher = Join-Path $InstallDir "refresher.js"
$disabledRefresher = Join-Path $InstallDir "refresher.js.disabled"
Move-Item $refresher $disabledRefresher
try {
  Start-Process $DesktopShortcutPath
  $failure = Wait-VisibleWindow -Title "Usage Panel - Could not open" -Attempts 90
  if (-not (Test-Path $DiagnosticFile)) { throw "sanitized diagnostic file was not written" }
  $diagnostics = Get-Content $DiagnosticFile
  if ($diagnostics -notmatch " SERVER_FAILED$") { throw "server failure diagnostic was not recorded" }
  foreach ($line in $diagnostics) {
    if ($line -notmatch '^\d{4}-\d{2}-\d{2}T[^ ]+ [A-Z_]+$') {
      throw "launcher diagnostic contained non-status data"
    }
  }
  Write-Host "silent_child_exit=visible_plain_english_failure;diagnostics=status_only"
} finally {
  Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Stop-Process -Force
  Move-Item $disabledRefresher $refresher -Force
  & (Join-Path $InstallDir "uninstall-helper.ps1")
  Wait-PanelStopped
}

# Invoke the exact helper used after successful direct Start Menu linking and
# require one visible app window and a ready dashboard.
& (Join-Path $InstallDir "open-panel-after-link.ps1")
$handoff = Wait-VisibleWindow
Wait-PanelReady
Wait-DiagnosticStatus -Status "WEBVIEW_READY"
$visibleCount = @(Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and [UsagePanelWindowCheck]::IsWindowVisible($_.MainWindowHandle)
}).Count
if ($visibleCount -ne 1) { throw "post-link handoff created $visibleCount visible windows" }

Invoke-Uninstall
if (Test-Path $InstallDir) {
  Get-ChildItem $InstallDir -Recurse -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "uninstall_residual=$($_.Name)" }
  throw "install directory remained after uninstall"
}
if (Test-Path $DesktopShortcutPath) { throw "Desktop shortcut remained after uninstall" }
if (Test-Path $StartMenuDir) { throw "Start Menu shortcuts remained after uninstall" }

Remove-Item $EnrollmentDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $DiagnosticDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "installer_smoke=panel_visible_launch_diagnostics_shortcuts_uninstall_ok"
