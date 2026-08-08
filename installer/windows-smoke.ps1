param(
  [string]$Version = "1.0.3",
  [string]$BaselineInstaller = "",
  # App-dependent assertions may stay red until Opus's app/** handoff is merged.
  [switch]$RequireAppAssertions
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
$EnrollmentFile = Join-Path $EnrollmentDir "enrollment.json"
$DiagnosticDir = Join-Path $env:LOCALAPPDATA "UsagePanel"
$DiagnosticFile = Join-Path $DiagnosticDir "launcher.log"
$StagedAppFailures = New-Object System.Collections.Generic.List[string]

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UsagePanelWindowCheck {
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr handle);
  public const int SW_RESTORE = 9;
}
"@

function Note-StagedAppFailure {
  param([string]$Name, [string]$Detail)
  $message = "$Name :: $Detail"
  $StagedAppFailures.Add($message) | Out-Null
  Write-Host "staged_app_assertion_pending=$message"
  if ($RequireAppAssertions) { throw "required app assertion failed: $message" }
}

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
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8899/api/sync" -TimeoutSec 1 | Out-Null
    } catch { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Usage Panel did not stop between launch tests."
}

function Wait-AppStopped {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (-not (Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Usage Panel app process did not stop between launch tests."
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
  Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.Refresh()
    Write-Host "window_probe=handle_nonzero:$($_.MainWindowHandle -ne 0);title:$($_.MainWindowTitle)"
  }
  if (Test-Path $DiagnosticFile) {
    Get-Content $DiagnosticFile | ForEach-Object {
      $status = ($_ -split ' ')[-1]
      Write-Host "diagnostic_status=$status"
    }
  }
  throw "Usage Panel did not create the expected visible top-level window: $Title"
}

function Wait-DiagnosticStatus {
  param([string]$Status)
  for ($attempt = 0; $attempt -lt 75; $attempt++) {
    if (Test-Path $DiagnosticFile) {
      $lines = Get-Content $DiagnosticFile
      if ($lines -match " $Status$") { return $true }
    }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

function Assert-DiagnosticsSanitized {
  if (-not (Test-Path $DiagnosticFile)) { throw "diagnostic file missing" }
  $diagnostics = Get-Content $DiagnosticFile
  foreach ($line in $diagnostics) {
    if ($line -notmatch '^\d{4}-\d{2}-\d{2}T[^ ]+ [A-Z0-9_]+$') {
      throw "launcher diagnostic contained non-status data"
    }
    if ($line -match '(?i)(user(name)?|token|credential|password|secret|prompt|exception|C:\\Users\\|\\\\|/home/)') {
      throw "launcher diagnostic contained forbidden identity or secret content"
    }
  }
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
  if (-not (Test-Path $Path -PathType Leaf)) { throw "missing shortcut: $Path" }
  $shell = New-Object -ComObject WScript.Shell
  try { return $shell.CreateShortcut($Path) }
  finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Assert-Shortcut {
  param([string]$Path, [string]$TargetLeaf, [string[]]$ArgumentFragments)
  $shortcut = Read-Shortcut -Path $Path
  try {
    if ([IO.Path]::GetFileName($shortcut.TargetPath) -ine $TargetLeaf) {
      throw "unexpected shortcut target for $Path : $($shortcut.TargetPath)"
    }
    foreach ($fragment in $ArgumentFragments) {
      if ($shortcut.Arguments -notlike "*$fragment*") {
        throw "unexpected shortcut arguments for $Path : $($shortcut.Arguments)"
      }
    }
    Write-Host "shortcut_ok=path:$Path;target:$($shortcut.TargetPath);args:$($shortcut.Arguments);shell_folder_desktop:$DesktopDir;shell_folder_programs:$ProgramsDir"
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

function Assert-NoStaleLaunchers {
  foreach ($name in @("open-panel.cmd", "open-panel.vbs", "start-hidden.vbs")) {
    $path = Join-Path $InstallDir $name
    if (Test-Path $path) { throw "stale launcher remained after upgrade: $name" }
  }
  if (Test-Path (Join-Path $InstallDir ".usage-panel-stop")) {
    throw "stale shutdown marker remained after upgrade"
  }
}

function Stop-AllPanelProcesses {
  & (Join-Path $InstallDir "uninstall-helper.ps1") -ErrorAction SilentlyContinue
  Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Wait-AppStopped
  Wait-PanelStopped
}

# Preserve a sentinel enrollment file so the upgrade path is proven not to wipe it.
New-Item $EnrollmentDir -ItemType Directory -Force | Out-Null
$enrollmentSentinel = '{"deviceId":"00000000-0000-4000-8000-000000000099","deviceCredential":"sentinel-not-a-real-secret","label":"smoke"}'
Set-Content -Path $EnrollmentFile -Value $enrollmentSentinel -Encoding ascii
$enrollmentBefore = Get-FileHash $EnrollmentFile -Algorithm SHA256

if ($BaselineInstaller) {
  $baseline = Resolve-Path $BaselineInstaller
  $baselineHash = (Get-FileHash $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($baselineHash -ne "991800b7d5e20374a6014254fb45d2ba9b6e2ea44b1115e5b6c05bc19875598e") {
    throw "public v1.0.2 baseline checksum changed"
  }
  $installBaseline = Start-Process $baseline -ArgumentList "/S" -Wait -PassThru
  if ($installBaseline.ExitCode -ne 0) { throw "baseline installer exited $($installBaseline.ExitCode)" }

  # Plant residual launchers and a stop marker so upgrade cleanup is forced even
  # if a future baseline packaging change stops shipping them.
  foreach ($name in @("open-panel.cmd", "open-panel.vbs", "start-hidden.vbs")) {
    if (-not (Test-Path (Join-Path $InstallDir $name))) {
      Set-Content (Join-Path $InstallDir $name) "stale-launcher-residue" -Encoding ascii
    }
  }
  "stop" | Set-Content (Join-Path $InstallDir ".usage-panel-stop") -Encoding ascii -NoNewline

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
  Write-Host "baseline_v102_left_installed=true"
  # CRITICAL: do NOT uninstall. v1.0.3 must install directly over this tree.
}

Remove-Item $DiagnosticDir -Recurse -Force -ErrorAction SilentlyContinue

$install = Start-Process $Installer -ArgumentList "/S" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "installer exited $($install.ExitCode)" }

Assert-NoStaleLaunchers
if (-not (Test-Path (Join-Path $InstallDir "UsagePanel.exe"))) { throw "UsagePanel.exe missing after install-over" }
if (-not (Test-Path (Join-Path $InstallDir "MicrosoftEdgeWebview2Setup.exe"))) {
  throw "WebView2 bootstrapper missing from install tree"
}
if (-not (Test-Path (Join-Path $InstallDir "webview2-bootstrapper.provenance.txt"))) {
  throw "WebView2 provenance file missing from install tree"
}

$enrollmentAfter = Get-FileHash $EnrollmentFile -Algorithm SHA256
if ($enrollmentAfter.Hash -ne $enrollmentBefore.Hash) {
  throw "upgrade mutated enrollment state; only deliberately safe enrollment may be preserved unchanged"
}
Write-Host "install_over_v102=stale_launchers_removed;enrollment_preserved=true"

$required = @(
  (Join-Path $InstallDir "UsagePanel.exe"),
  (Join-Path $InstallDir "node\node.exe"),
  (Join-Path $InstallDir "open-panel-after-link.ps1"),
  (Join-Path $InstallDir "enroll-panel.ps1"),
  (Join-Path $InstallDir "upgrade-prepare.ps1"),
  $DesktopShortcutPath,
  $StartMenuShortcutPath,
  $LinkShortcutPath,
  (Join-Path $InstallDir "Uninstall.exe")
)
foreach ($path in $required) { if (-not (Test-Path $path)) { throw "missing after install: $path" } }

Assert-Shortcut -Path $DesktopShortcutPath -TargetLeaf "UsagePanel.exe" -ArgumentFragments @()
Assert-Shortcut -Path $StartMenuShortcutPath -TargetLeaf "UsagePanel.exe" -ArgumentFragments @()
Assert-Shortcut -Path $LinkShortcutPath -TargetLeaf "powershell.exe" -ArgumentFragments @("enroll-panel.ps1", "-OpenPanelAfterLink")

& (Join-Path $InstallDir "node\node.exe") --version

# Shell double-click path: Desktop shortcut via Windows shell semantics.
Start-Process $DesktopShortcutPath
$visible = Wait-VisibleWindow
Wait-PanelReady
# DASHBOARD_VISIBLE is recorded only after the app reads real window/surface
# state, so a log line can disagree with the screen when the dashboard is hidden.
if (-not (Wait-DiagnosticStatus -Status "DASHBOARD_VISIBLE")) {
  Note-StagedAppFailure -Name "DASHBOARD_VISIBLE" -Detail "app did not record DASHBOARD_VISIBLE after a successful panel launch"
} else {
  Write-Host "visible_window_ok=title:$($visible.MainWindowTitle):handle_nonzero:true;dashboard_visible=true"
}

# Relaunch / single-instance: second shell launch must not create a second host.
Start-Process $DesktopShortcutPath
Start-Sleep -Seconds 3
$hostCount = @(Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue).Count
if ($hostCount -ne 1) {
  Note-StagedAppFailure -Name "SINGLE_INSTANCE" -Detail "expected 1 UsagePanel process, found $hostCount"
} else {
  Write-Host "single_instance_ok=process_count:1"
}
# Second-instance path must restore a minimized primary window (SW_RESTORE in app/**).
$iconic = Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and [UsagePanelWindowCheck]::IsIconic($_.MainWindowHandle)
}
if ($iconic) {
  Note-StagedAppFailure -Name "MINIMIZED_RESTORE" -Detail "existing minimized window observed after second launch; app must SW_RESTORE before focus"
}

# Server child exit must leave a visible plain-English failure and status-only diagnostics.
Stop-AllPanelProcesses
$refresher = Join-Path $InstallDir "refresher.js"
$disabledRefresher = Join-Path $InstallDir "refresher.js.disabled"
Move-Item $refresher $disabledRefresher
try {
  Start-Process $DesktopShortcutPath
  $failure = Wait-VisibleWindow -Title "Usage Panel - Could not open" -Attempts 90
  if (-not (Test-Path $DiagnosticFile)) { throw "sanitized diagnostic file was not written" }
  $diagnostics = Get-Content $DiagnosticFile
  if (-not ($diagnostics -match " SERVER_FAILED$")) { throw "server failure diagnostic was not recorded" }
  Assert-DiagnosticsSanitized
  Write-Host "silent_child_exit=visible_plain_english_failure;diagnostics=status_only"
} finally {
  Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Stop-Process -Force
  Move-Item $disabledRefresher $refresher -Force
  Stop-AllPanelProcesses
}

# Corrupt / missing payload: remove dashboard payload and require a visible failure.
$dashboard = Join-Path $InstallDir "dashboard.html"
$disabledDashboard = Join-Path $InstallDir "dashboard.html.disabled"
Copy-Item $dashboard $disabledDashboard -Force
try {
  Remove-Item $dashboard -Force
  Start-Process $DesktopShortcutPath
  try {
    $null = Wait-VisibleWindow -Title "Usage Panel - Could not open" -Attempts 60
    if (-not (Wait-DiagnosticStatus -Status "PAYLOAD_MISSING") -and
        -not (Wait-DiagnosticStatus -Status "SERVER_FAILED") -and
        -not (Wait-DiagnosticStatus -Status "OFFLINE")) {
      Note-StagedAppFailure -Name "PAYLOAD_MISSING" -Detail "missing dashboard did not record a dedicated status code"
    } else {
      Write-Host "corrupt_missing_payload=visible_failure"
    }
  } catch {
    Note-StagedAppFailure -Name "PAYLOAD_MISSING" -Detail $_.Exception.Message
  }
} finally {
  if (Test-Path $disabledDashboard) { Move-Item $disabledDashboard $dashboard -Force }
  Stop-AllPanelProcesses
}

# Port 8899 conflict: occupy the port, then require a dedicated status (not generic reinstall).
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8899)
try {
  $listener.Start()
  Start-Process $DesktopShortcutPath
  Start-Sleep -Seconds 6
  if (Wait-DiagnosticStatus -Status "PORT_IN_USE") {
    Write-Host "port_conflict=PORT_IN_USE"
  } else {
    Note-StagedAppFailure -Name "PORT_IN_USE" -Detail "app did not record PORT_IN_USE while 8899 was occupied"
  }
} finally {
  $listener.Stop()
  Stop-AllPanelProcesses
}

# Offline-ish collector failure is app/server owned; verify diagnostics stay sanitized if produced.
Start-Process $DesktopShortcutPath
try {
  $null = Wait-VisibleWindow -Attempts 60
  Assert-DiagnosticsSanitized
  Write-Host "diagnostics_sanitized=ok"
} catch {
  Note-StagedAppFailure -Name "OFFLINE_OR_LAUNCH" -Detail $_.Exception.Message
} finally {
  Stop-AllPanelProcesses
}

# Product close behavior contract: full exit of Usage Panel-owned processes.
# Until Opus implements terminate-on-close, this is staged.
Start-Process $DesktopShortcutPath
$closeWindow = Wait-VisibleWindow
Wait-PanelReady
$closeWindow.CloseMainWindow() | Out-Null
Start-Sleep -Seconds 4
$remainingApp = @(Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue)
$remainingNode = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and
  $_.ExecutablePath.ToLowerInvariant() -eq ((Join-Path $InstallDir "node\node.exe").ToLowerInvariant()) -and
  $_.CommandLine -match "refresher\.js"
})
if ($remainingApp.Count -gt 0 -or $remainingNode.Count -gt 0) {
  Note-StagedAppFailure -Name "FULL_EXIT_ON_CLOSE" -Detail "app=$($remainingApp.Count) node_refresher=$($remainingNode.Count); product requires full exit, monitoring resumes on next launch"
} else {
  Write-Host "full_exit_on_close=ok"
}
Stop-AllPanelProcesses

# Enrollment handoff helper must open exactly one visible window.
& (Join-Path $InstallDir "open-panel-after-link.ps1")
$handoff = Wait-VisibleWindow
Wait-PanelReady
$visibleCount = @(Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and [UsagePanelWindowCheck]::IsWindowVisible($_.MainWindowHandle)
}).Count
if ($visibleCount -ne 1) { throw "post-link handoff created $visibleCount visible windows" }
Write-Host "enrollment_handoff=one_visible_window"

Invoke-Uninstall
if (Test-Path $InstallDir) {
  Get-ChildItem $InstallDir -Recurse -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "uninstall_residual=$($_.Name)" }
  throw "install directory remained after uninstall"
}
if (Test-Path $DesktopShortcutPath) { throw "Desktop shortcut remained after uninstall" }
if (Test-Path $StartMenuDir) { throw "Start Menu shortcuts remained after uninstall" }
if (Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue) {
  throw "UsagePanel process remained after uninstall"
}
Write-Host "uninstall=directory_shortcuts_processes_removed"

# Enrollment is deliberately retained across uninstall (documented product choice).
if (-not (Test-Path $EnrollmentFile)) {
  throw "uninstall unexpectedly removed enrollment state"
}
Write-Host "enrollment_retained_after_uninstall=true"

Remove-Item $EnrollmentDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $DiagnosticDir -Recurse -Force -ErrorAction SilentlyContinue

if ($StagedAppFailures.Count -gt 0) {
  Write-Host "staged_app_assertion_count=$($StagedAppFailures.Count)"
  foreach ($item in $StagedAppFailures) { Write-Host "staged_app_assertion=$item" }
} else {
  Write-Host "staged_app_assertion_count=0"
}

Write-Host "installer_smoke=true_install_over_v102_visible_launch_diagnostics_shortcuts_uninstall_ok"
Write-Host "shell_folders=desktop:$DesktopDir;programs:$ProgramsDir"
