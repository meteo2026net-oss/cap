$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-backup.ps1"
if (-not (Test-Path (Join-Path $root "package.json"))) { throw "Run this script from the CAP repository." }
if (-not (Test-Path (Join-Path $root ".env"))) { throw "Run start-local.bat or npm run setup:local before installing scheduled backups." }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw "npm.cmd was not found. Install Node.js 22+ first." }
$taskName = "Meteo CAP Daily Database Backup"
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner + '"'
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At "2:00AM"
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Creates and validates a SQLite CAP database backup every day at 02:00 while this Windows user is signed in." -Force | Out-Null
Write-Output "Installed '$taskName'. It runs daily at 02:00 when this Windows user is signed in."
Write-Output ("Logs: " + (Join-Path $root "logs"))
Write-Output ("Run once now with: powershell -NoProfile -ExecutionPolicy Bypass -File " + $runner)
