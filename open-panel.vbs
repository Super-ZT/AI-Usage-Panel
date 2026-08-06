' Runs open-panel.cmd without flashing a console window.
CreateObject("Wscript.Shell").Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\open-panel.cmd""", 0, False
