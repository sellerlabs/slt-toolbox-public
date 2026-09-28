Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """<SCHEDULER_DIR>\start-scheduler.bat""", 0, False
Set WshShell = Nothing
