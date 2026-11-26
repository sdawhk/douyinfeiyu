' Run a console executable with its window hidden.
Option Explicit
Dim shell, i, command, cwd
Set shell = CreateObject("WScript.Shell")
cwd = WScript.Arguments(0)
shell.CurrentDirectory = cwd
command = Quote(WScript.Arguments(1))
For i = 2 To WScript.Arguments.Count - 1
  command = command & " " & Quote(WScript.Arguments(i))
Next
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
