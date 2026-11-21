' Starts the proxy in the background without a console window.
' Portable: resolves its own folder, so it can live anywhere.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c cd /d """ & dir & """ && node src\server.mjs >> server.log 2>> server.err.log", 0, False
