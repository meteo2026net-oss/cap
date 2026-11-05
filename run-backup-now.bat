@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 22+ first.
  pause
  exit /b 1
)
call npm run backup
if errorlevel 1 (
  echo Backup failed. Review the message above.
  pause
  exit /b 1
)
echo Backup completed and validated.
pause
