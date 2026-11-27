@echo off
rem Run DBCentral's automated tests (pytest). Extra arguments go to pytest, e.g.  run_tests.bat -k import
rem
rem MySQL/MariaDB tests run only when DBCENTRAL_TEST_MYSQL is set, for example:
rem     set DBCENTRAL_TEST_MYSQL=root:password@127.0.0.1:3306
rem They create and drop schemas named dbcentral_*, so point them at a test server, never production.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    call setup.bat /quiet
    if errorlevel 1 exit /b 1
)
".venv\Scripts\python.exe" -c "import pytest" >nul 2>&1
if errorlevel 1 (
    echo Installing pytest...
    ".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements-dev.txt
    if errorlevel 1 exit /b 1
)
".venv\Scripts\python.exe" -m pytest %*
