' Regenerates the scheduled-runs HTML dashboard and opens it in the browser.
' Runs node windowless so a double-click shows no console flash.
Dim sh, fso, appDir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = appDir & "\JS App"
sh.Run "cmd /c node ""scheduled-runs-viewer.js""", 0, False
