@echo off
rem Keep this file ASCII only: cmd.exe parses .bat files in the ANSI codepage,
rem so Korean text here breaks commands.
rem
rem   start.bat            start the server and open the browser
rem   start.bat /startup   used by the Windows login shortcut (install-startup.bat):
rem                        no browser, quietly exits if the server is already running
setlocal
cd /d "%~dp0"
title WoS Scopus Export Server

set "STARTUP="
if /i "%~1"=="/startup" set "STARTUP=1"

set "PORT=4100"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env" 2^>nul') do set "PORT=%%b"

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    if defined STARTUP exit /b 0
    echo Already running. Opening the browser only.
    start "" "http://localhost:%PORT%"
    exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo Install the LTS version from https://nodejs.org, then run this file again.
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" copy ".env.example" ".env" >nul
    echo A new .env file was created. Put your Scopus API key in it.
    echo Features that need no keys work without it.
    echo.
)

if not exist "node_modules" (
    echo First run: installing required packages, please wait...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install packages.
        pause
        exit /b 1
    )
)

if not defined STARTUP (
    start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"
)

echo WoS-Scopus Export is running: http://localhost:%PORT%
echo Close this window or press Ctrl+C to stop the server.
echo.
node server.js

echo.
echo Server stopped.
rem Keep the window open even for /startup, so an error message stays visible in the (minimized) window.
pause
