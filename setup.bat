@echo off
setlocal EnableExtensions
rem DBCentral setup: creates a Python virtual environment (.venv) next to this file and installs
rem the dependencies. Safe to run again at any time. Use "setup.bat /quiet" to skip the questions.
cd /d "%~dp0"
title DBCentral setup

rem An environment copied from another PC points at that PC's Python and does not work here.
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import sys" >nul 2>&1
    if errorlevel 1 (
        echo The existing .venv folder does not work on this PC. Recreating it...
        rmdir /s /q ".venv"
    )
)

if exist ".venv\Scripts\python.exe" goto :install

rem Find Python 3.10 or newer: the "py" launcher first, then python / python3 on PATH.
set "PY="
for %%C in ("py -3" "python" "python3") do (
    if not defined PY (
        %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 && set "PY=%%~C"
    )
)
if not defined PY goto :no_python

for /f "delims=" %%V in ('%PY% -c "import sys; print(sys.version.split()[0])"') do set "PYVER=%%V"
echo Creating the virtual environment with Python %PYVER%...
%PY% -m venv .venv
if errorlevel 1 goto :venv_failed

:install
echo Installing DBCentral's Python packages...
set "PIP=.venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-warn-script-location -q"
if exist "wheels\" (
    %PIP% --no-index --find-links wheels -r requirements.txt >nul 2>&1
    if not errorlevel 1 goto :installed
    echo The bundled packages do not fit this Python version; downloading them instead...
)
%PIP% -r requirements.txt
if errorlevel 1 goto :pip_failed

:installed
".venv\Scripts\python.exe" -c "import flask, waitress, pymysql, keyring, paramiko, pyodbc" >nul 2>&1
if errorlevel 1 goto :pip_failed
echo DBCentral is ready.

if /i "%~1"=="/quiet" goto :done
echo.
choice /c YN /n /t 60 /d Y /m "Create DBCentral shortcuts on the desktop and in the Start menu? [Y/N] "
if errorlevel 2 goto :done
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\shortcut.ps1"

:done
exit /b 0

:no_python
echo.
echo DBCentral needs Python 3.10 or newer, and none was found on this PC.
echo Install it from https://www.python.org/downloads/ and run this again.
echo In the installer, tick "Add python.exe to PATH" or keep the "py launcher" option.
goto :fail

:venv_failed
echo.
echo Could not create the virtual environment with %PY%.
goto :fail

:pip_failed
echo.
echo Installing the Python packages failed. The first setup needs an internet connection,
echo unless this copy of DBCentral includes a "wheels" folder that matches your Python version.
goto :fail

:fail
echo.
if /i not "%~1"=="/quiet" pause
exit /b 1
