@echo off
setlocal
title "WorkshopOne Server - Edward and Christie Central Workshop"

:: Always run from the directory where this script is located
cd /d "%~dp0"

echo ================================================================
echo   WorkshopOne - Central Workshop Master System
echo   Edward and Christie (Pvt) Ltd - Badalgama
echo ================================================================
echo.

:: 1. Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found in your system PATH.
    echo Please install Node.js version 20 or higher from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 2. Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] First time setup: node_modules missing. Installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install npm dependencies.
        pause
        exit /b 1
    )
)

:: 3. Check if server is already listening on port 3000
::    3000 is the port the server actually binds: the default in src/config.js and .env.example, the
::    one deploy/DEPLOY.md opens on the firewall, and the one deploy/RUNBOOK.md gives the team.
::    This script used to check, announce and open the throwaway port deploy/VPS.md sets aside for
::    the office DEVELOPMENT copy -- "a port nobody has bookmarked" -- so it opened a browser there
::    while starting the live server on 3000, and the page never loaded. If a machine must use a
::    different port, set PORT in its .env and change the three URLs below to match.
netstat -ano | findstr /C:":3000 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [NOTE] WorkshopOne server is already running on port 3000.
    echo [INFO] Opening browser at http://localhost:3000 ...
    start "" "http://localhost:3000"
    goto end
)

:: 4. Start the server
echo [INFO] Starting WorkshopOne Server...
echo [INFO] Local Address:  http://localhost:3000
echo [INFO] Press Ctrl+C in this window at any time to stop the server.
echo.

:: Open browser
start "" "http://localhost:3000"

:: Run Node server
node src/server.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server stopped with error code %ERRORLEVEL%.
    pause
)

:end
