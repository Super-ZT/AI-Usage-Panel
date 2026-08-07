@echo off
REM Usage Panel — starts the local server and restarts it if it exits.
REM Locates Node automatically; no machine-specific paths.
setlocal
REM The bundled script and runtime use absolute paths. Keep this long-lived
REM launcher out of the install directory so it cannot lock that folder.
cd /d "%TEMP%"

set "NODE_EXE="
set "STOP_FILE=%~dp0.usage-panel-stop"

REM 1. Explicit override wins.
if defined USAGE_PANEL_NODE if exist "%USAGE_PANEL_NODE%" set "NODE_EXE=%USAGE_PANEL_NODE%"

REM 2. Prefer the runtime bundled by the Windows installer.
if not defined NODE_EXE if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

REM 3. Node on PATH (developer/source installs only).
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)

REM 4. Common install locations (developer/source installs only).
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo Node.js was not found.
  echo Install it from https://nodejs.org, or set USAGE_PANEL_NODE to node.exe
  exit /b 1
)

:loop
if exist "%STOP_FILE%" exit /b 0
"%NODE_EXE%" "%~dp0refresher.js"
if "%errorlevel%"=="66" exit /b 0
if exist "%STOP_FILE%" exit /b 0
timeout /t 3 /nobreak >nul
goto loop
