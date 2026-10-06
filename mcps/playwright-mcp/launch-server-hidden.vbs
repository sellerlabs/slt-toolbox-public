' launch-server-hidden.vbs
'
' Starts playwright-mcp-server.js with NO console window.
'
' Why this shim exists: the shared server is launched by a Scheduled Task (so it
' runs in the INTERACTIVE desktop session AND escapes VS Code's Job Object -- see
' ensureServer() in playwright-mcp-visible.js). But Task Scheduler has no
' ShowWindow/SW_HIDE option, so pointing the task action straight at node.exe
' always allocates a conhost.exe console that sits visibly on the desktop.
'
' WScript.Shell's Run() takes an explicit window style. Style 0 = hidden, and
' bWaitOnReturn = False returns immediately, leaving node running detached.
' wscript.exe itself is windowless, so nothing flashes.
'
' Arg 0: full path to node.exe
' Arg 1: full path to playwright-mcp-server.js

Option Explicit

Dim shell, args, nodeExe, serverScript, workDir, fso, cmd

Set args = WScript.Arguments
If args.Count < 2 Then
  WScript.Quit 1
End If

nodeExe = args(0)
serverScript = args(1)

Set fso = CreateObject("Scripting.FileSystemObject")
workDir = fso.GetParentFolderName(serverScript)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workDir

cmd = """" & nodeExe & """ """ & serverScript & """"

' 0 = hidden window, False = don't wait for it to exit
shell.Run cmd, 0, False
