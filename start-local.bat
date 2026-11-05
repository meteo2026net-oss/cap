@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install Node.js 22 LTS or newer and try again.
  exit /b 1
)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if not defined NODE_MAJOR (
  echo Unable to detect the installed Node.js version.
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22 or newer is required. Detected: 
  node --version
  exit /b 1
)
if not exist ".env" (
  call npm run setup:local
  if errorlevel 1 exit /b 1
)
if not exist "node_modules" (
  call npm ci
  if errorlevel 1 exit /b 1
)
call npm start
