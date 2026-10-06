@echo off
rem Keep this file ASCII only (cmd.exe reads .bat files in the ANSI codepage).
rem   stop-server.bat      show what will be stopped, then ask
rem   stop-server.bat /y   stop without asking
rem Only the process listening on this tool's port is stopped; other Node programs are left alone.
setlocal enabledelayedexpansion
cd /d "%~dp0"
title WoS-Scopus Export - stop server

set "PORT=4100"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env" 2^>nul') do set "PORT=%%b"
set "AUTO="
if /i "%~1"=="/y" set "AUTO=1"

echo.
echo   WoS-Scopus Export - stop server (port %PORT%)
echo   ---------------------------------------------
echo.

rem Collect PIDs listening on the port (IPv4/IPv6 can list the same PID twice)
set "PIDS="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo !PIDS! | findstr /c:"[%%p]" >nul || set "PIDS=!PIDS![%%p]"
)

if "%PIDS%"=="" (
    echo   The server is not running. (nothing is listening on port %PORT%^)
    echo.
    if not defined AUTO pause
    exit /b 0
)

for %%q in (%PIDS%) do (
    set "P=%%q"
    set "P=!P:[=!"
    set "P=!P:]=!"
    set "NAME=?"
    for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq !P!" /fo csv /nh 2^>nul') do set "NAME=%%~n"
    echo   Target: PID !P!   !NAME!
)
echo.

if not defined AUTO (
    set /p "YN=  Stop it? (Y/N) "
    if /i not "!YN!"=="Y" (
        echo.
        echo   Cancelled.
        echo.
        pause
        exit /b 0
    )
    echo.
)

for %%q in (%PIDS%) do (
    set "P=%%q"
    set "P=!P:[=!"
    set "P=!P:]=!"
    taskkill /PID !P! /T /F
)
rem Close the server console window too (start.bat keeps it open with pause after the server exits)
taskkill /F /FI "WINDOWTITLE eq WoS Scopus Export Server*" >nul 2>&1

echo.
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo   Stopped. Port %PORT% is free.
) else (
    echo   [WARN] Port %PORT% is still in use. Check node.exe in Task Manager.
)
echo.
if not defined AUTO pause
