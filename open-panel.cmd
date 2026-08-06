@echo off
REM Opens the Usage Panel as an app window, starting the server first if needed.
cd /d "%~dp0"
set URL=http://localhost:8899

REM quick TCP check: is anything listening on 8899?
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',8899); exit 0}catch{exit 1}finally{$c.Close()}" >nul 2>&1
if errorlevel 1 (
  start "" wscript.exe "%~dp0start-hidden.vbs"
  REM wait up to ~9s for the server to come up
  powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',8899); exit 0}catch{Start-Sleep -Milliseconds 300}finally{$c.Close()}}; exit 1" >nul 2>&1
)

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1520,940
) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1520,940
) else (
  start "" %URL%
)
