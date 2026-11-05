@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remove-daily-backup.ps1"
if errorlevel 1 (
  echo Could not remove the daily backup task.
  pause
  exit /b 1
)
pause
