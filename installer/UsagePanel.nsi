!include "MUI2.nsh"

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

Section "Usage Panel" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  Delete "$INSTDIR\.usage-panel-stop"
  File /r "..\dist\app\*"

  WriteRegStr HKCU "Software\UsagePanel" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "DisplayName" "Usage Panel"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "Publisher" "Super ZT"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "DisplayIcon" "$INSTDIR\usage-panel.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\UsagePanel" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"

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
