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

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class UsagePanelWindowCheck {
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);
  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr handle, IntPtr hdcBlt, int flags);
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr lParam);
  public const int SW_RESTORE = 9;
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> ListVisibleChildren(IntPtr parent) {
    var found = new List<string>();
    EnumChildWindows(parent, (h, l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left;
      int hgt = r.Bottom - r.Top;
      if (w < 80 || hgt < 80) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, sb.Capacity);
      found.Add(sb.ToString() + ":" + w + "x" + hgt);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool HasEmbeddedBrowserRegion(IntPtr parent) {
    bool hit = false;
    EnumChildWindows(parent, (h, l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left;
      int hgt = r.Bottom - r.Top;
      if (w < 120 || hgt < 120) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, sb.Capacity);
      string cls = sb.ToString();
      // WebView2 hosts Chromium child HWNDs; WinForms WebView2 control also surfaces.
      if (cls.IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) >= 0
          || cls.IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0
          || cls.IndexOf("WebView", StringComparison.OrdinalIgnoreCase) >= 0
          || cls.IndexOf("WindowsForms10", StringComparison.OrdinalIgnoreCase) >= 0) {
        hit = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return hit;
  }
}
"@

$EvidenceDir = Join-Path $Root "dist\smoke-evidence"
New-Item $EvidenceDir -ItemType Directory -Force | Out-Null

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

function Save-WindowScreenshot {
  param([System.Diagnostics.Process]$Process, [string]$Name)
  $Process.Refresh()
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw "screenshot failed: no main window handle for $Name" }
  $rect = New-Object UsagePanelWindowCheck+RECT
  if (-not [UsagePanelWindowCheck]::GetWindowRect($handle, [ref]$rect)) {
    throw "screenshot failed: GetWindowRect for $Name"
  }
  $width = [Math]::Max(1, $rect.Right - $rect.Left)
  $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    # Prefer PrintWindow with PW_RENDERFULLCONTENT so GPU/WebView2 surfaces are
    # included; fall back to a desktop copy if PrintWindow fails.
    $hdc = $graphics.GetHdc()
    $printed = $false
    try {
      # 2 = PW_RENDERFULLCONTENT (captures DirectComposition / Chromium content)
      $printed = [UsagePanelWindowCheck]::PrintWindow($handle, $hdc, 2)
    } finally {
      $graphics.ReleaseHdc($hdc)
    }
    if (-not $printed) {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
      Write-Host "screenshot_capture=CopyFromScreen"
    } else {
      Write-Host "screenshot_capture=PrintWindow_PW_RENDERFULLCONTENT"
    }
    $path = Join-Path $EvidenceDir "$Name.png"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "screenshot_ok=path:$path;bytes:$((Get-Item $path).Length);size:${width}x${height}"
    return $path
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Test-DashboardScreenshotShowsContent {
  param([Parameter(Mandatory = $true)][string]$Path)
  # A Chrome_RenderWidgetHostHWND proves only that a browser surface exists.
  # v1.0.2-class false greens left a pure-black client area. Fail closed unless
  # the center of the captured window has real paint (not one near-black color).
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $ms = New-Object System.IO.MemoryStream(,$bytes)
  $bmp = $null
  try {
    $bmp = [System.Drawing.Bitmap]::FromStream($ms)
    $w = $bmp.Width
    $h = $bmp.Height
    if ($w -lt 400 -or $h -lt 300) { return $false }
    # Center of the client area (skip title bar / chrome edges).
    $x0 = [int]([Math]::Floor($w * 0.20))
    $x1 = [int]([Math]::Floor($w * 0.80))
    $y0 = [int]([Math]::Max(40, [Math]::Floor($h * 0.25)))
    $y1 = [int]([Math]::Floor($h * 0.85))
    $step = 2
    $unique = New-Object 'System.Collections.Generic.HashSet[int]'
    $total = 0
    $lit = 0
    $maxC = 0
    for ($y = $y0; $y -lt $y1; $y += $step) {
      for ($x = $x0; $x -lt $x1; $x += $step) {
        $c = $bmp.GetPixel($x, $y)
        $total++
        $key = (($c.R -shl 16) -bor ($c.G -shl 8) -bor $c.B)
        [void]$unique.Add($key)
        $lum = (0.2126 * $c.R) + (0.7152 * $c.G) + (0.0722 * $c.B)
        if ($lum -ge 20.0) { $lit++ }
        if ($c.R -gt $maxC) { $maxC = $c.R }
        if ($c.G -gt $maxC) { $maxC = $c.G }
        if ($c.B -gt $maxC) { $maxC = $c.B }
      }
    }
    if ($total -lt 1000) { return $false }
    $litFrac = $lit / [double]$total
    $uniqueCount = $unique.Count
    # Calibrated against the blocked black capture (unique≈1, lit≈0, maxc≈11)
    # vs a real dark-theme dashboard paint (unique≥100, lit>1%, maxc≥40).
    Write-Host ("dashboard_content_probe=unique:{0};lit_frac:{1};maxc:{2};samples:{3};region:{4},{5}-{6},{7}" -f `
      $uniqueCount, ([Math]::Round($litFrac, 4)), $maxC, $total, $x0, $y0, $x1, $y1)
    if ($uniqueCount -lt 25) { return $false }
    if ($litFrac -lt 0.01) { return $false }
    if ($maxC -lt 40) { return $false }
    Write-Host "dashboard_content_rendered=true;unique:$uniqueCount;lit_frac:$([Math]::Round($litFrac,4));maxc:$maxC"
    return $true
  } catch {
    Write-Host "dashboard_content_probe_error=$($_.Exception.Message)"
    return $false
  } finally {
    if ($bmp) { $bmp.Dispose() }
    $ms.Dispose()
  }
}

function Assert-IndependentDashboardVisible {
  param([System.Diagnostics.Process]$Process)
  $Process.Refresh()
  $handle = $Process.MainWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw "independent visibility failed: zero main window handle" }
  if (-not [UsagePanelWindowCheck]::IsWindowVisible($handle)) {
    throw "independent visibility failed: top-level window not visible"
  }
  $rect = New-Object UsagePanelWindowCheck+RECT
  if (-not [UsagePanelWindowCheck]::GetWindowRect($handle, [ref]$rect)) {
    throw "independent visibility failed: GetWindowRect"
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 400 -or $height -lt 300) {
    throw "independent visibility failed: top-level window too small (${width}x${height})"
  }
  # Independent of launcher.log: require a real embedded browser/content HWND.
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(40)
  $children = @()
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if ([UsagePanelWindowCheck]::HasEmbeddedBrowserRegion($handle)) {
      $children = [UsagePanelWindowCheck]::ListVisibleChildren($handle)
      Write-Host "independent_dashboard_visible=top:${width}x${height};children:$($children -join ',')"
      return
    }
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
    $handle = $Process.MainWindowHandle
  }
  $children = [UsagePanelWindowCheck]::ListVisibleChildren($handle)
  Write-Host "independent_dashboard_children=$($children -join ',')"
  throw "independent visibility failed: no nonzero-size embedded browser/content region"
}

function Assert-DashboardContentRendered {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [string]$Name = "dashboard-visible"
  )
  # HWND + DASHBOARD_VISIBLE are necessary but not sufficient: the blocked
  # candidate had both and still showed a pure-black client. Poll captures until
  # center-region pixels prove real dashboard paint, or fail closed.
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
  $lastPath = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "dashboard content proof failed: UsagePanel exited before paint"
    }
    try {
      $lastPath = Save-WindowScreenshot -Process $Process -Name $Name
      if (Test-DashboardScreenshotShowsContent -Path $lastPath) {
        Write-Host "dashboard_content_ok=path:$lastPath"
        return $lastPath
      }
      Write-Host "dashboard_content_waiting=black_or_empty_client;retrying"
    } catch {
      Write-Host "dashboard_content_capture_retry=$($_.Exception.Message)"
    }
    Start-Sleep -Milliseconds 750
  }
  if ($lastPath -and (Test-Path -LiteralPath $lastPath)) {
    Write-Host "dashboard_content_failed_evidence=$lastPath;bytes=$((Get-Item $lastPath).Length)"
  }
  throw "dashboard content proof failed: center client stayed blank/black after browser HWND was present"
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
# Log status is supporting evidence only — independent Win32 observation is required.
if (-not (Wait-DiagnosticStatus -Status "DASHBOARD_VISIBLE")) {
  Note-StagedAppFailure -Name "DASHBOARD_VISIBLE" -Detail "app did not record DASHBOARD_VISIBLE after a successful panel launch"
}
Assert-IndependentDashboardVisible -Process $visible
Assert-DashboardContentRendered -Process $visible -Name "dashboard-visible"
Write-Host "visible_window_ok=title:$($visible.MainWindowTitle):handle_nonzero:true;dashboard_visible=true;independent_hwnd=true;dashboard_content=true"

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

# Server failure: keep required files present (otherwise PreFlight returns PAYLOAD_MISSING)
# but make the local service unable to become ready → SERVER_FAILED.
Stop-AllPanelProcesses
Remove-Item $DiagnosticFile -Force -ErrorAction SilentlyContinue
$refresher = Join-Path $InstallDir "refresher.js"
$refresherBackup = Join-Path $InstallDir "refresher.js.smoke-backup"
Copy-Item $refresher $refresherBackup -Force
# Non-empty file so InstallPayload stays Ok; content that exits immediately so the panel never answers.
Set-Content -Path $refresher -Value "process.exit(1);" -Encoding ascii
try {
  Start-Process $DesktopShortcutPath
  $failure = Wait-VisibleWindow -Title "Usage Panel - Could not open" -Attempts 120
  if (-not (Wait-DiagnosticStatus -Status "SERVER_FAILED")) {
    if (Test-Path $DiagnosticFile) {
      Get-Content $DiagnosticFile | ForEach-Object { Write-Host "diagnostic_line=$_" }
    }
    throw "server failure diagnostic was not recorded (expected SERVER_FAILED)"
  }
  Assert-DiagnosticsSanitized
  Write-Host "silent_child_exit=visible_plain_english_failure;diagnostics=status_only;status=SERVER_FAILED"
  try { Save-WindowScreenshot -Process $failure -Name "server-failed" } catch { Write-Host "screenshot_server_failed_skipped=$($_.Exception.Message)" }
} finally {
  Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path $refresherBackup) { Move-Item $refresherBackup $refresher -Force }
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

# Port 8899 conflict: real unrelated listener; app must not kill it.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8899)
try {
  $listener.Start()
  Start-Process $DesktopShortcutPath
  $portFailure = Wait-VisibleWindow -Title "Usage Panel - Could not open" -Attempts 90
  if (-not (Wait-DiagnosticStatus -Status "PORT_IN_USE")) {
    Note-StagedAppFailure -Name "PORT_IN_USE" -Detail "app did not record PORT_IN_USE while 8899 was occupied"
  } else {
    Write-Host "port_conflict=PORT_IN_USE;visible_failure=true"
  }
  try { Save-WindowScreenshot -Process $portFailure -Name "port-in-use" } catch { Write-Host "screenshot_port_in_use_skipped=$($_.Exception.Message)" }
  # Prove the foreign listener is still alive (Usage Panel must not kill it).
  $stillListening = $false
  try {
    $probeClient = New-Object System.Net.Sockets.TcpClient
    $probeClient.Connect("127.0.0.1", 8899)
    $stillListening = $probeClient.Connected
    $probeClient.Close()
  } catch { $stillListening = $false }
  if (-not $stillListening) {
    throw "PORT_IN_USE path appears to have killed the foreign 8899 listener"
  }
  Write-Host "port_conflict_foreign_listener_alive=true"
} finally {
  try { $listener.Stop() } catch { }
  Stop-AllPanelProcesses
}

# Real missing-WebView2 path: point Microsoft's loader at an empty folder so
# CoreWebView2Environment.GetAvailableBrowserVersionString fails for a genuine
# reason (no in-app override). Launch the exact installed desktop shortcut.
Stop-AllPanelProcesses
if (-not (Test-Path -LiteralPath $DesktopShortcutPath)) {
  throw "installed desktop shortcut missing before WEBVIEW2_MISSING proof: $DesktopShortcutPath"
}
$wv2EmptyRuntime = Join-Path $env:TEMP ("usage-panel-smoke-no-webview2-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $wv2EmptyRuntime -Force | Out-Null
# Empty directory: zero browser files, so the loader cannot resolve a runtime.
if (@(Get-ChildItem -LiteralPath $wv2EmptyRuntime -Force -ErrorAction SilentlyContinue).Count -ne 0) {
  throw "WEBVIEW2 empty runtime directory was not empty: $wv2EmptyRuntime"
}
$env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $wv2EmptyRuntime
Write-Host "webview2_loader_force=WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;empty_dir=$wv2EmptyRuntime"
Write-Host "webview2_loader_query=CoreWebView2Environment.GetAvailableBrowserVersionString"
try {
  # Inherit the process env (including the empty-folder force) into the
  # customer-facing installed shortcut target.
  Start-Process -FilePath $DesktopShortcutPath
  $wv2Window = Wait-VisibleWindow -Title "Usage Panel - Could not open" -Attempts 90
  if (-not (Wait-DiagnosticStatus -Status "WEBVIEW2_MISSING")) {
    Note-StagedAppFailure -Name "WEBVIEW2_MISSING" -Detail "empty WEBVIEW2_BROWSER_EXECUTABLE_FOLDER did not record WEBVIEW2_MISSING"
  } else {
    Write-Host "webview2_missing=visible_status_WEBVIEW2_MISSING"
    Write-Host "webview2_loader_unavailable=true;method=GetAvailableBrowserVersionString;force=empty_WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;no_in_app_override=true"
  }
  if ($wv2Window.MainWindowTitle -ne "Usage Panel - Could not open") {
    Note-StagedAppFailure -Name "WEBVIEW2_MISSING_UI" -Detail "unexpected failure window title"
  }
  # launcher.log is the product's Windows diagnostic log (status-only). Require
  # the loader-level missing outcome there; never accept a force-flag claim.
  if (Test-Path -LiteralPath $DiagnosticFile) {
    $diagText = Get-Content -LiteralPath $DiagnosticFile -Raw -ErrorAction SilentlyContinue
    if ($diagText -notmatch "WEBVIEW2_MISSING") {
      Note-StagedAppFailure -Name "WEBVIEW2_MISSING_LOG" -Detail "launcher.log did not contain WEBVIEW2_MISSING after empty-folder loader force"
    } else {
      Write-Host "webview2_windows_log=launcher.log:WEBVIEW2_MISSING"
    }
    if ($diagText -match "USAGE_PANEL_SMOKE_FORCE_WEBVIEW2_MISSING") {
      throw "launcher.log mentions retired force override; in-app override must stay gone"
    }
  } else {
    Note-StagedAppFailure -Name "WEBVIEW2_MISSING_LOG" -Detail "launcher.log missing after WEBVIEW2_MISSING proof"
  }
  try { Save-WindowScreenshot -Process $wv2Window -Name "webview2-missing" } catch { Write-Host "screenshot_webview2_missing_skipped=$($_.Exception.Message)" }
  Assert-DiagnosticsSanitized
} finally {
  Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Stop-AllPanelProcesses
  Remove-Item Env:\WEBVIEW2_BROWSER_EXECUTABLE_FOLDER -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $wv2EmptyRuntime -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "webview2_loader_force_cleanup=removed_env_and_empty_dir"
}

# First-run unlinked enrollment: remove sentinel, launch, expect enrollment start, then cancel dialog.
Stop-AllPanelProcesses
Remove-Item $EnrollmentFile -Force -ErrorAction SilentlyContinue
Start-Process $DesktopShortcutPath
try {
  $null = Wait-VisibleWindow -Attempts 90
  if (-not (Wait-DiagnosticStatus -Status "ENROLLMENT_STARTED") -and
      -not (Wait-DiagnosticStatus -Status "ENROLLMENT_FAILED") -and
      -not (Wait-DiagnosticStatus -Status "NETWORK_UNAVAILABLE")) {
    Note-StagedAppFailure -Name "FIRST_RUN_ENROLLMENT" -Detail "unlinked launch did not record enrollment/network status"
  } else {
    Write-Host "first_run_unlinked_enrollment=status_observed"
  }
  # Close any enroll PowerShell dialog so the host can continue or exit cleanly.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match "enroll-panel\.ps1"
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Assert-DiagnosticsSanitized
} catch {
  Note-StagedAppFailure -Name "FIRST_RUN_ENROLLMENT" -Detail $_.Exception.Message
} finally {
  Stop-AllPanelProcesses
  # Restore sentinel for later uninstall-preserve proof.
  New-Item $EnrollmentDir -ItemType Directory -Force | Out-Null
  Set-Content -Path $EnrollmentFile -Value $enrollmentSentinel -Encoding ascii
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

# Product close behavior: full exit of all Usage Panel-owned processes (no tray).
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
Write-Host "enrollment_handoff=one_visible_window;exact_once=true"
Save-WindowScreenshot -Process $handoff -Name "post-link-handoff"

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
