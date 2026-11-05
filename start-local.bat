@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install Node.js 22 LTS or newer and try again.
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. Repair or reinstall Node.js 22 LTS or newer.
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
echo Verifying and installing the exact locked dependencies...
call npm ci
if errorlevel 1 (
  echo Dependency installation failed. Check your internet connection and Node.js build tools.
  exit /b 1
)
start "Meteo CAP Warning System" /D "%~dp0" cmd /k "npm start"
if errorlevel 1 (
  echo Unable to launch the CAP server.
  exit /b 1
)
echo Waiting for the local API to become ready...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(30); do { try { $response=Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8095/api/health/ready -TimeoutSec 2; if ($response.StatusCode -eq 200) { Start-Process http://127.0.0.1:8095; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); Write-Host 'The server did not become ready within 30 seconds. Check the server window.'; exit 1"
if errorlevel 1 exit /b 1
