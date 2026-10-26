$desktop = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$shortcutPath = Join-Path $desktop "Jarvis OS.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "D:\1\jaros\Jarvis.exe"
$shortcut.WorkingDirectory = "D:\1\jaros"
$shortcut.IconLocation = "D:\1\jaros\src-tauri\icons\icon.ico"
$shortcut.Description = "Jarvis Autonomous OS"
$shortcut.Save()

if (Test-Path $shortcutPath) {
    Write-Output "SUCCESS: Desktop shortcut created at $shortcutPath"
} else {
    Write-Output "ERROR: Desktop shortcut creation failed"
}

# ── Auto-start on Laptop Boot ──
$startup = [System.Environment]::GetFolderPath('Startup')
$startupShortcutPath = Join-Path $startup "Jarvis OS.lnk"
$startupShortcut = $wsh.CreateShortcut($startupShortcutPath)
$startupShortcut.TargetPath = "D:\1\jaros\Jarvis.exe"
$startupShortcut.WorkingDirectory = "D:\1\jaros"
$startupShortcut.IconLocation = "D:\1\jaros\src-tauri\icons\icon.ico"
$startupShortcut.Description = "Jarvis Autonomous OS Startup"
$startupShortcut.Save()

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Jarvis" -Value '"D:\1\jaros\Jarvis.exe"'

Write-Output "SUCCESS: Laptop Startup shortcut created at $startupShortcutPath"
Write-Output "SUCCESS: Registry Run key configured for Jarvis.exe"
