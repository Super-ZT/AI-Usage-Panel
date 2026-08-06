' Launches the Usage Panel server with no visible console window.
CreateObject("Wscript.Shell").Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\start-panel.cmd""", 0, False
