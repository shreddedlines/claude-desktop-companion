' Starts Claude Notifier (watchdog + tray app) with no console window.
' Uses the bundled runtime ClaudeNotifier.exe next to this file (installed/release layout), so Node.js does NOT
' need to be installed. Only a development checkout without that file falls back to "node" on PATH.
' Every path is derived from this script's own location; the working directory is the application folder.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
runtime = dir & "\ClaudeNotifier.exe"
If fso.FileExists(runtime) Then
  sh.Run """" & runtime & """ """ & dir & "\supervisor.js""", 0, False
Else
  sh.Run "node """ & dir & "\supervisor.js""", 0, False
End If
