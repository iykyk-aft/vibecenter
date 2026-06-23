' Vibe Center launcher — runs the Node launcher with no console window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node """ & dir & "\launch.mjs""", 0, False
