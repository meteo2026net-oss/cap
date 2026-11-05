$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDirectory = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDirectory "backup-$stamp.log"
"Backup started at $(Get-Date -Format o)" | Set-Content -Path $logFile -Encoding UTF8
try {
  & npm.cmd run backup *>> $logFile
  $exitCode = $LASTEXITCODE
  "Backup process exit code: $exitCode" | Add-Content -Path $logFile -Encoding UTF8
  if ($exitCode -ne 0) { throw "Backup command failed with exit code $exitCode. See $logFile" }
  Write-Output "Verified database backup completed. Log: $logFile"
} catch {
  "Backup failed: $($_.Exception.Message)" | Add-Content -Path $logFile -Encoding UTF8
  Write-Error "Daily backup failed. See $logFile"
  exit 1
}
