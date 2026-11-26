' Run a batch watchdog without exposing its cmd.exe console window.
Option Explicit
Dim shell, fso, workDir, batchPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
workDir = WScript.Arguments(0)
batchPath = WScript.Arguments(1)
shell.CurrentDirectory = workDir
command = """" & shell.ExpandEnvironmentStrings("%ComSpec%") & """ /c call """ & batchPath & """"
shell.Run command, 0, False
