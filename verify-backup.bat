@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: verify-backup.bat backups\cap-YYYYMMDDTHHMMSSZ-UUID.sqlite
  pause
  exit /b 2
)
call npm run backup:verify -- "%~1"
if errorlevel 1 (
  echo Backup verification failed. Do not use this file for restoration.
  pause
  exit /b 1
)
echo Backup checksum, SQLite integrity, and audit chain verified.
pause
