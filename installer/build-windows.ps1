param(
  [string]$Version = "1.0.1"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Stage = Join-Path $Dist "app"
$NodeVersion = "24.19.0"
$NodeArchive = "node-v$NodeVersion-win-x64.zip"
$NodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeArchive"

Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Stage -ItemType Directory -Force | Out-Null

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
  "start-hidden.vbs",
  "open-panel.cmd",
  "open-panel.vbs",
  "enroll-panel.ps1",
  "uninstall-helper.ps1"
)
foreach ($relative in $clientFiles) {
  Copy-Item (Join-Path $Root $relative) $Stage -Recurse -Force
}

$Download = Join-Path $env:RUNNER_TEMP $NodeArchive
Invoke-WebRequest -UseBasicParsing -Uri $NodeUrl -OutFile $Download
$ActualNodeHash = (Get-FileHash $Download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualNodeHash -ne $NodeSha256) {
  throw "Portable Node archive checksum mismatch."
}

$Extracted = Join-Path $env:RUNNER_TEMP "usage-panel-node"
Remove-Item $Extracted -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $Download -DestinationPath $Extracted -Force
Copy-Item (Join-Path $Extracted "node-v$NodeVersion-win-x64") (Join-Path $Stage "node") -Recurse -Force

$forbidden = @("server", "ops", "test", ".git", ".github")
foreach ($name in $forbidden) {
  if (Test-Path (Join-Path $Stage $name)) { throw "Forbidden installer content: $name" }
}
if (-not (Test-Path (Join-Path $Stage "node\node.exe"))) {
  throw "Portable Node runtime was not staged."
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
"$Hash  UsagePanel-Setup-$Version.exe" | Set-Content (Join-Path $Dist "UsagePanel-Setup-$Version.exe.sha256") -Encoding ascii
Write-Host "installer=$Installer"
Write-Host "sha256=$Hash"
