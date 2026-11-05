@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" (
  echo Dependencies are missing. Run start-local.bat or npm ci first.
  pause
  exit /b 1
)
call npm.cmd run backup:list -- %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo One or more backups could not be verified. Review the JSON error details above.
  pause
)
exit /b %RESULT%
