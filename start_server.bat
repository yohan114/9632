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

:: 3. Check if server is already listening on port 1929
netstat -ano | findstr /C:":1929 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [NOTE] WorkshopOne server is already running on port 1929.
    echo [INFO] Opening browser at http://localhost:1929 ...
    start "" "http://localhost:1929"
    goto end
)

:: 4. Start the server
echo [INFO] Starting WorkshopOne Server...
echo [INFO] Local Address:  http://localhost:1929
echo [INFO] Press Ctrl+C in this window at any time to stop the server.
echo.

:: Open browser
start "" "http://localhost:1929"

:: Run Node server
node src/server.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server stopped with error code %ERRORLEVEL%.
    pause
)

:end
