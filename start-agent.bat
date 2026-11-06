@echo off
rem Starts the StockOja Sales Agent and opens the dashboard. Close this window (or press Ctrl+C) to stop it.
setlocal
cd /d "%~dp0"
title StockOja Sales Agent

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
if not exist ".env" (
  echo Missing .env. Copy .env.example to .env and fill it in. See README.md, "First-time setup".
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Installing dependencies, first run only...
  call npm install --no-fund --no-audit
  if errorlevel 1 ( pause & exit /b 1 )
)

rem --background (used by "Start with Windows"): start without opening the browser.
if /i "%~1"=="--background" (
  call npm start
) else (
  call npm start -- --open
)
echo.
pause
