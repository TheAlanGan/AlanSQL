@echo off
rem Build dist\DBCentral-<version>.zip to copy DBCentral to another PC. Add --no-wheels for a smaller zip
rem whose setup downloads the Python packages instead of using bundled ones.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call setup.bat /quiet || exit /b 1
".venv\Scripts\python.exe" tools\make_dist.py %*
if errorlevel 1 pause
