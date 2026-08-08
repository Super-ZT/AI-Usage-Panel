param(
  [string]$Version = "1.0.3"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Stage = Join-Path $Dist "app"
$NodeVersion = "24.19.0"
$NodeArchive = "node-v$NodeVersion-win-x64.zip"
$NodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeArchive"

# Microsoft Edge WebView2 Evergreen Bootstrapper (small online installer).
# Pinned CDN object resolved from https://go.microsoft.com/fwlink/p/?LinkId=2124703
# on 2026-08-08. Build fails closed if the bytes drift.
$WebView2File = "MicrosoftEdgeWebview2Setup.exe"
$WebView2Url = "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/bc30c82c-6362-4795-bb08-5351ad5a93bd/MicrosoftEdgeWebview2Setup.exe"
$WebView2Sha256 = "e99838c51bb3379b244654aa77e33032d42fc2b5d224c5babce432d9fd3dcb28"
$WebView2Official = "https://developer.microsoft.com/microsoft-edge/webview2/"

Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Stage -ItemType Directory -Force | Out-Null

# Prefer RUNNER_TEMP on GitHub Actions, but fall back so local/dev builds work
# outside Actions-only paths (Chief gate: not GHA-only).
$WorkRoot = $env:RUNNER_TEMP
if (-not $WorkRoot) { $WorkRoot = $env:TEMP }
if (-not $WorkRoot) { $WorkRoot = $env:TMP }
if (-not $WorkRoot) { $WorkRoot = Join-Path $Root ".scratch\windows-build" }
New-Item $WorkRoot -ItemType Directory -Force | Out-Null
Write-Host "build_work_root=$WorkRoot"

$HostPublish = Join-Path $WorkRoot "usage-panel-host"
Remove-Item $HostPublish -Recurse -Force -ErrorAction SilentlyContinue
dotnet publish (Join-Path $Root "app\UsagePanel.csproj") `
  --configuration Release --runtime win-x64 --self-contained true `
  --output $HostPublish --nologo
if ($LASTEXITCODE -ne 0) { throw "UsagePanel.exe build failed with exit code $LASTEXITCODE" }
Copy-Item (Join-Path $HostPublish "*") $Stage -Recurse -Force
if (-not (Test-Path (Join-Path $Stage "UsagePanel.exe"))) {
  throw "UsagePanel.exe was not staged."
}

$clientFiles = @(
  "bin",
  "src",
  "refresher.js",
  "dashboard.html",
  "config.example.json",
  "package.json",
  "LICENSE",
  "usage-panel.ico",
  "start-panel.cmd",
  "open-panel-after-link.ps1",
  "enroll-panel.ps1",
  "uninstall-helper.ps1"
)
foreach ($relative in $clientFiles) {
  Copy-Item (Join-Path $Root $relative) $Stage -Recurse -Force
}

# Package the upgrade helper so uninstall/repair tooling can reuse it if needed.
Copy-Item (Join-Path $PSScriptRoot "upgrade-prepare.ps1") $Stage -Force

$Download = Join-Path $WorkRoot $NodeArchive
Invoke-WebRequest -UseBasicParsing -Uri $NodeUrl -OutFile $Download
$ActualNodeHash = (Get-FileHash $Download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualNodeHash -ne $NodeSha256) {
  throw "Portable Node archive checksum mismatch."
}

$Extracted = Join-Path $WorkRoot "usage-panel-node"
Remove-Item $Extracted -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $Download -DestinationPath $Extracted -Force
Copy-Item (Join-Path $Extracted "node-v$NodeVersion-win-x64") (Join-Path $Stage "node") -Recurse -Force

$WebView2Download = Join-Path $WorkRoot $WebView2File
Invoke-WebRequest -UseBasicParsing -Uri $WebView2Url -OutFile $WebView2Download
$ActualWebView2Hash = (Get-FileHash $WebView2Download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualWebView2Hash -ne $WebView2Sha256) {
  throw "WebView2 Evergreen bootstrapper checksum mismatch. Refusing to package an unpinned dependency."
}
Copy-Item $WebView2Download (Join-Path $Stage $WebView2File) -Force
@(
  "name=$WebView2File",
  "source_url=$WebView2Url",
  "official_docs=$WebView2Official",
  "sha256=$WebView2Sha256",
  "purpose=install Microsoft Edge WebView2 runtime only when missing",
  "architecture=win-x64 host; bootstrapper itself is Evergreen"
) | Set-Content (Join-Path $Stage "webview2-bootstrapper.provenance.txt") -Encoding ascii

$forbidden = @("server", "ops", "test", ".git", ".github")
foreach ($name in $forbidden) {
  if (Test-Path (Join-Path $Stage $name)) { throw "Forbidden installer content: $name" }
}
if (-not (Test-Path (Join-Path $Stage "node\node.exe"))) {
  throw "Portable Node runtime was not staged."
}
if (-not (Test-Path (Join-Path $Stage $WebView2File))) {
  throw "WebView2 bootstrapper was not staged."
}

$MakeNsis = Get-Command makensis.exe -ErrorAction SilentlyContinue
if (-not $MakeNsis) {
  $candidate = "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
  if (Test-Path $candidate) { $MakeNsis = Get-Item $candidate }
}
if (-not $MakeNsis) { throw "makensis.exe was not found. Install NSIS first." }

$MakeNsisPath = if ($MakeNsis.Source) { $MakeNsis.Source } else { $MakeNsis.FullName }
Push-Location $PSScriptRoot
try {
  & $MakeNsisPath "/DVERSION=$Version" "/DOUTPUT_DIR=$Dist" "UsagePanel.nsi"
  if ($LASTEXITCODE -ne 0) { throw "NSIS installer build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$Installer = Join-Path $Dist "UsagePanel-Setup-$Version.exe"
if (-not (Test-Path $Installer)) { throw "Expected installer was not produced: $Installer" }
$Hash = (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
$Size = (Get-Item $Installer).Length
"$Hash  UsagePanel-Setup-$Version.exe" | Set-Content (Join-Path $Dist "UsagePanel-Setup-$Version.exe.sha256") -Encoding ascii
@(
  "artifact=UsagePanel-Setup-$Version.exe",
  "bytes=$Size",
  "sha256=$Hash",
  "architecture=win-x64",
  "node_sha256=$NodeSha256",
  "webview2_bootstrapper_sha256=$WebView2Sha256"
) | Set-Content (Join-Path $Dist "UsagePanel-Setup-$Version.exe.evidence.txt") -Encoding ascii
Write-Host "installer=$Installer"
Write-Host "sha256=$Hash"
Write-Host "bytes=$Size"
Write-Host "architecture=win-x64"
