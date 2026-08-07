@echo off
REM Opens the Usage Panel as an app window, starting the server first if needed.
REM Keep every child process out of the install directory so Windows can remove
REM it cleanly during a later uninstall.
cd /d "%TEMP%"
set URL=http://localhost:8899

REM First run: let the customer paste the one-time code created in the portal.
REM Cancelling keeps the local-only dashboard available.
if not exist "%APPDATA%\usage-panel\enrollment.json" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enroll-panel.ps1"
)

REM Verify the Usage Panel itself, not merely an unrelated listener on port 8899.
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/sync' -TimeoutSec 2;if($r.StatusCode -eq 200){exit 0}}catch{};exit 1" >nul 2>&1
if errorlevel 1 (
  start "" wscript.exe "%~dp0start-hidden.vbs"
  REM wait up to ~9s for the server to come up
  powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{$r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/sync' -TimeoutSec 2;if($r.StatusCode -eq 200){exit 0}}catch{};Start-Sleep -Milliseconds 300};exit 1" >nul 2>&1
  if errorlevel 1 (
    echo Usage Panel did not start successfully. 1>&2
    exit /b 1
  )
)

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1520,940
) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1520,940
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1520,940
) else (
  start "" %URL%
)
