@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install Node.js LTS and try again.
  exit /b 1
)
if not exist ".env" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-local.ps1"
  if errorlevel 1 exit /b 1
)
if not exist "node_modules" (
  call npm install
  if errorlevel 1 exit /b 1
)
call npm start
