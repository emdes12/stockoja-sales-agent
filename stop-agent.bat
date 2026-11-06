@echo off
rem Asks a running Sales Agent to stop cleanly (same as "Quit app" in the dashboard).
setlocal
cd /d "%~dp0"
set PORT=6400
if exist ".env" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b "PORT=" ".env"') do set PORT=%%b
)
curl -s -X POST -H "X-Agent-Client: dashboard" http://127.0.0.1:%PORT%/api/app/shutdown >nul 2>nul
if errorlevel 1 (
  echo The sales agent does not seem to be running on port %PORT%.
) else (
  echo Stop requested. The agent is shutting down cleanly.
)
timeout /t 3 >nul
