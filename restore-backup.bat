@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: restore-backup.bat backups\cap-YYYYMMDDTHHMMSSZ-UUID.sqlite [--force]
  echo Stop the CAP server and delivery worker before restoring.
  pause
  exit /b 2
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js 22+ first.
  pause
  exit /b 1
)
call npm run restore -- "%~1" %~2
if errorlevel 1 (
  echo Restore failed. Check the message above before restarting the server.
  pause
  exit /b 1
)
echo Restore command completed. Verify the application and restored records before resuming operations.
pause
