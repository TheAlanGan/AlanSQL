# Create DBCentral shortcuts (desktop and Start menu) that start the app without a console window.
# Run by setup.bat; you can also run it yourself:  powershell -ExecutionPolicy Bypass -File tools\shortcut.ps1
param([switch]$DesktopOnly)

$root = Split-Path -Parent $PSScriptRoot
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $pythonw)) {
    Write-Host "Run setup.bat first: $pythonw was not found."
    exit 1
}
$folders = @([Environment]::GetFolderPath("Desktop"))
if (-not $DesktopOnly) { $folders += [Environment]::GetFolderPath("Programs") }

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in $folders) {
    if (-not $folder -or -not (Test-Path $folder)) { continue }
    $path = Join-Path $folder "DBCentral.lnk"
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = '"' + (Join-Path $root "launch.py") + '"'
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = (Join-Path $root "static\img\dbcentral.ico") + ",0"
    $lnk.Description = "DBCentral - SQL client for MySQL/MariaDB and SQLite"
    $lnk.Save()
    Write-Host "Created $path"
}
