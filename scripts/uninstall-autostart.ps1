param(
  [string]$TaskName = "SalesMessageLoggerAutoStart"
)

$ErrorActionPreference = "Stop"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Autostart removed: $TaskName"

