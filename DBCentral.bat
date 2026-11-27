@echo off
rem Start DBCentral in its own app window. The first start on a PC runs setup.bat.
cd /d "%~dp0"
".venv\Scripts\python.exe" -c "import flask, waitress, pymysql, keyring, paramiko, pyodbc" >nul 2>&1
if errorlevel 1 (
    echo DBCentral needs to finish setting up on this PC. Running setup first...
    call "%~dp0setup.bat"
    if errorlevel 1 exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" "%~dp0launch.py" %*
