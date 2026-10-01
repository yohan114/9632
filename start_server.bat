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

:: 3. Which port this PC uses
::    THIS SCRIPT AND THE SERVER MUST AGREE ON IT, and they did not. The script checked, announced
::    and opened 1929 while `node src/server.js` bound 3000 -- the default in src/config.js --
::    because nothing here ever passed the port on to node. That is two failures at once: the
::    browser opened a dead address, and on this PC, where another server already holds 3000, the
::    app could not bind at all and stopped on startup. "Nobody can sign in" was the whole of the
::    symptom, because there was no server to sign in to.
::
::    1929 is this machine's port, not a stray number: deploy/VPS.md keeps the office copy on "a
::    port nobody has bookmarked" and starts it with PORT=1929. The live VPS sets its own PORT in
::    .env and is untouched by anything below.
::
::    scripts/resolved-port.js answers with the port the app WILL bind whenever one is configured
::    (PORT in the environment, or PORT in .env) and stays silent when none is. Only then does the
::    default below apply -- and it is handed to node, so the port this script opens is the port
::    the server binds. To change the port, set PORT in .env (it wins over this) or edit one line.
set "PORT_DEFAULT=1929"
set "APP_PORT="
for /f "delims=" %%P in ('node scripts\resolved-port.js') do set "APP_PORT=%%P"
if not defined APP_PORT set "APP_PORT=%PORT_DEFAULT%"
if not defined PORT set "PORT=%APP_PORT%"

:: 4. Check if the server is already listening on that port
netstat -ano | findstr /C:":%APP_PORT% " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [NOTE] WorkshopOne server is already running on port %APP_PORT%.
    echo [INFO] Opening browser at http://localhost:%APP_PORT% ...
    start "" "http://localhost:%APP_PORT%"
    goto end
)

:: 5. Start the server
echo [INFO] Starting WorkshopOne Server...
echo [INFO] Local Address:  http://localhost:%APP_PORT%
echo [INFO] Press Ctrl+C in this window at any time to stop the server.
echo.

:: Open browser
start "" "http://localhost:%APP_PORT%"

:: Run Node server
node src/server.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server stopped with error code %ERRORLEVEL%.
    pause
)

:end
