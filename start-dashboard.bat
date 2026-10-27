@echo off
rem Muse Dashboard - start-dashboard.bat
rem Author: Adam S. Barnett
rem
rem Starts the dashboard on Windows (double-click it). On the first start it
rem installs the dependencies (npm ci) and creates config.json from
rem config.example.json. Settings > Restart exits with code 75; this window
rem then starts the server again. Extra arguments go to server.js
rem (for example: start-dashboard.bat --port 4321 --no-open --debug).
setlocal
title Muse Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js 20 or newer from https://nodejs.org and try again.
  timeout /t 30
  exit /b 1
)

if not exist "node_modules\@muse-code\sdk\package.json" (
  echo First start: installing the dashboard's dependencies...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Installing the dependencies failed. See the messages above, then try again.
    timeout /t 60
    exit /b 1
  )
)
if not exist "config.json" copy /y "config.example.json" "config.json" >nul

echo Starting Muse Dashboard... your browser will open automatically.
echo It stops by itself a while after you close the last dashboard tab (idleShutdownSeconds in config.json).
echo You can also close this window or press Ctrl+C to stop it now.
echo.
set MUSE_DASHBOARD_SUPERVISED=1
:run
node server.js %*
if errorlevel 75 if not errorlevel 76 goto run
if errorlevel 1 (
  echo.
  echo Muse Dashboard stopped with an error. See the messages above.
  echo This window closes in 60 seconds.
  timeout /t 60
)
endlocal
exit /b 0
