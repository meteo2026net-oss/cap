$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path (Join-Path $root ".env"))) { throw "Local .env is missing. Run start-local.bat or npm run setup:local before scheduling backups." }
$logDirectory = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDirectory "backup-$stamp.log"
"Backup started at $(Get-Date -Format o)" | Set-Content -Path $logFile -Encoding UTF8
try {
  & npm.cmd run backup 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
  $exitCode = $LASTEXITCODE
  "Backup process exit code: $exitCode" | Add-Content -Path $logFile -Encoding UTF8
  if ($exitCode -ne 0) { throw "Backup command failed with exit code $exitCode. See $logFile" }
  Write-Output "Verified database backup completed. Log: $logFile"
} catch {
  "Backup failed: $($_.Exception.Message)" | Add-Content -Path $logFile -Encoding UTF8
  Write-Error "Daily backup failed. See $logFile"
  exit 1
}
