$ErrorActionPreference = "Stop"
$taskName = "Meteo CAP Daily Database Backup"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output "No scheduled CAP backup task is installed."
  exit 0
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Removed '$taskName'. Existing backup files were not deleted."
