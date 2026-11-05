@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-daily-backup.ps1"
if errorlevel 1 (
  echo Could not install the daily backup task.
  pause
  exit /b 1
)
pause
