!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "1.0.3"
!endif
!ifndef OUTPUT_DIR
  !define OUTPUT_DIR "..\dist"
!endif

Name "Usage Panel"
OutFile "${OUTPUT_DIR}\UsagePanel-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Usage Panel"
InstallDirRegKey HKCU "Software\UsagePanel" "InstallDir"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_ICON "..\usage-panel.ico"
!define MUI_UNICON "..\usage-panel.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\UsagePanel.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Usage Panel"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var UpgradePrepareExit

Section "Usage Panel" SEC_MAIN
  SetShellVarContext current
  InitPluginsDir

  ; Stage helpers before touching the install directory so an upgrade can stop
  ; v1.0.2 processes and remove obsolete launchers without half-writing files.
  SetOutPath "$PLUGINSDIR"
  File "upgrade-prepare.ps1"

  DetailPrint "Preparing install directory for Usage Panel ${VERSION}..."
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\upgrade-prepare.ps1" -InstallDir "$INSTDIR" -SkipWebView2' $UpgradePrepareExit
  ${If} $UpgradePrepareExit != 0
    MessageBox MB_OK|MB_ICONSTOP "Usage Panel could not prepare the install folder.$\r$\n$\r$\nClose any open Usage Panel windows and try again. The installer refuses a partial upgrade when files are locked."
    Abort
  ${EndIf}

  SetOutPath "$INSTDIR"
  Delete "$INSTDIR\.usage-panel-stop"
  ; Explicitly remove obsolete v1.0.2 launchers even if the helper already did.
  Delete "$INSTDIR\open-panel.cmd"
  Delete "$INSTDIR\open-panel.vbs"
  Delete "$INSTDIR\start-hidden.vbs"

  ClearErrors
  File /r "..\dist\app\*"
  IfErrors 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Usage Panel could not copy program files. Close Usage Panel and retry."
    Abort

  ; Fail closed if a locked upgrade left obsolete launchers behind.
  IfFileExists "$INSTDIR\open-panel.cmd" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Upgrade left obsolete open-panel.cmd behind. Close Usage Panel and retry."
    Abort
  IfFileExists "$INSTDIR\open-panel.vbs" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Upgrade left obsolete open-panel.vbs behind. Close Usage Panel and retry."
    Abort
  IfFileExists "$INSTDIR\start-hidden.vbs" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Upgrade left obsolete start-hidden.vbs behind. Close Usage Panel and retry."
    Abort

  ; Install Microsoft Edge WebView2 Evergreen bootstrapper only when missing.
  ; Detection is registry-based; the app also fails visibly with WEBVIEW2_MISSING.
  IfFileExists "$INSTDIR\MicrosoftEdgeWebview2Setup.exe" 0 webview2_done
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\upgrade-prepare.ps1" -InstallDir "$INSTDIR" -WebView2Bootstrapper "$INSTDIR\MicrosoftEdgeWebview2Setup.exe"' $UpgradePrepareExit
  webview2_done:

  WriteRegStr HKCU "Software\UsagePanel" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\UsagePanel" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\UsagePanel" "Architecture" "win-x64"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "DisplayName" "Usage Panel"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "Publisher" "Super ZT"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "DisplayIcon" "$INSTDIR\usage-panel.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Recreate shortcuts through current-user shell folders (includes OneDrive Desktop).
  CreateDirectory "$SMPROGRAMS\Usage Panel"
  CreateShortCut "$DESKTOP\Usage Panel.lnk" "$INSTDIR\UsagePanel.exe" "" "$INSTDIR\usage-panel.ico" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Usage Panel\Usage Panel.lnk" "$INSTDIR\UsagePanel.exe" "" "$INSTDIR\usage-panel.ico" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Usage Panel\Link this computer.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\enroll-panel.ps1" -OpenPanelAfterLink' "$INSTDIR\usage-panel.ico" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Usage Panel\Uninstall Usage Panel.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-helper.ps1"'
  Delete "$DESKTOP\Usage Panel.lnk"
  RMDir /r "$SMPROGRAMS\Usage Panel"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel"
  DeleteRegKey HKCU "Software\UsagePanel"
  RMDir /r "$INSTDIR"
SectionEnd
