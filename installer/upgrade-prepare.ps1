param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [string]$WebView2Bootstrapper = "",
  [switch]$SkipWebView2
)

$ErrorActionPreference = "Stop"

function Test-WebView2Installed {
  $keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  )
  foreach ($key in $keys) {
    if (Test-Path $key) {
      $version = (Get-ItemProperty -Path $key -Name "pv" -ErrorAction SilentlyContinue).pv
      if ($version -and $version -ne "0.0.0.0") { return $true }
    }
  }
  return $false
}

function Stop-UsagePanelOwnedProcesses {
  param([string]$Root)

  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $rootCompare = $resolvedRoot.ToLowerInvariant()

  # Stop known native host first so it releases file locks and child handles.
  $app = @(Get-Process -Name "UsagePanel" -ErrorAction SilentlyContinue)
  if ($app) {
    $app | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    $app | Wait-Process -Timeout 8 -ErrorAction SilentlyContinue
  }

  # Stop only node.exe that lives under this install and runs the panel refresher.
  $nodePath = (Join-Path $resolvedRoot "node\node.exe").ToLowerInvariant()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.ToLowerInvariant() -eq $nodePath -and
    $_.CommandLine -and
    ($_.CommandLine -match "refresher\.js" -or $_.CommandLine -match "usage-panel")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

  # Stop the v1.0.2 hidden launchers that still target this install directory.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().IndexOf($rootCompare) -ge 0 -and (
      ($_.Name -ieq "wscript.exe" -and $_.CommandLine -match "open-panel\.vbs|start-hidden\.vbs") -or
      ($_.Name -ieq "cmd.exe" -and $_.CommandLine -match "open-panel\.cmd|start-panel\.cmd") -or
      ($_.Name -ieq "cscript.exe" -and $_.CommandLine -match "open-panel\.vbs|start-hidden\.vbs")
    )
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Milliseconds 300
}

function Remove-StaleLaunchers {
  param([string]$Root)

  $stale = @(
    "open-panel.cmd",
    "open-panel.vbs",
    "start-hidden.vbs"
  )
  foreach ($name in $stale) {
    $path = Join-Path $Root $name
    if (Test-Path $path) {
      Remove-Item $path -Force -ErrorAction Stop
    }
  }

  $stopMarker = Join-Path $Root ".usage-panel-stop"
  if (Test-Path $stopMarker) {
    Remove-Item $stopMarker -Force -ErrorAction Stop
  }
}

function Assert-InstallDirWritable {
  param([string]$Root)

  if (-not (Test-Path $Root)) {
    New-Item $Root -ItemType Directory -Force | Out-Null
  }

  $probe = Join-Path $Root ".usage-panel-upgrade-probe"
  try {
    Set-Content -Path $probe -Value "ok" -Encoding ascii -ErrorAction Stop
    Remove-Item $probe -Force -ErrorAction Stop
  } catch {
    throw "install directory is locked or not writable; close Usage Panel and try again"
  }

  # If obsolete launcher names still exist after delete, refuse a half-upgrade.
  foreach ($name in @("open-panel.cmd", "open-panel.vbs", "start-hidden.vbs")) {
    if (Test-Path (Join-Path $Root $name)) {
      throw "stale launcher could not be removed: $name"
    }
  }
}

function Install-WebView2IfMissing {
  param([string]$Bootstrapper)

  if (Test-WebView2Installed) {
    Write-Host "webview2=already_present"
    return
  }
  if (-not $Bootstrapper -or -not (Test-Path $Bootstrapper)) {
    Write-Host "webview2=missing_bootstrapper_skipped"
    return
  }

  Write-Host "webview2=installing_evergreen_bootstrapper"
  $result = Start-Process -FilePath $Bootstrapper -ArgumentList "/silent", "/install" -Wait -PassThru
  if ($result.ExitCode -ne 0 -and $result.ExitCode -ne 3010) {
    # 3010 = success, reboot required. Do not block install; the app still
    # detects WEBVIEW2_MISSING and shows the official recovery path.
    Write-Host "webview2=bootstrapper_exit_$($result.ExitCode)"
    return
  }
  if (Test-WebView2Installed) {
    Write-Host "webview2=installed"
  } else {
    Write-Host "webview2=bootstrapper_finished_not_yet_visible"
  }
}

if (-not $InstallDir) { throw "InstallDir is required" }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

Stop-UsagePanelOwnedProcesses -Root $InstallDir
if (Test-Path $InstallDir) {
  Remove-StaleLaunchers -Root $InstallDir
}
Assert-InstallDirWritable -Root $InstallDir

if (-not $SkipWebView2) {
  Install-WebView2IfMissing -Bootstrapper $WebView2Bootstrapper
}

Write-Host "upgrade_prepare=ok"
exit 0
