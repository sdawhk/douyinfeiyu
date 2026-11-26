' Run a PowerShell task without creating a console window on the desktop.
Option Explicit
Dim shell, i, scriptPath, command
Set shell = CreateObject("WScript.Shell")
scriptPath = WScript.Arguments(0)
shell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(scriptPath)
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"
For i = 1 To WScript.Arguments.Count - 1
  command = command & " """ & WScript.Arguments(i) & """"
Next
shell.Run command, 0, False
