param(
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:LOCALAPPDATA "SalesMessageLogger"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Sales Message Logger"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Sales Message Logger.lnk"
$taskName = "SalesMessageLogger"

try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {
}

try {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like "*server.js*" -and
      $_.CommandLine -like "*SalesMessageLogger*"
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {
}

Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue

if ($RemoveData) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Sales Message Logger removed with local data."
  exit 0
}

$archiveRoot = Join-Path $env:LOCALAPPDATA "SalesMessageLogger.keep"
New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null

foreach ($name in @("logs", "config")) {
  $source = Join-Path $installRoot $name
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination $archiveRoot -Recurse -Force
  }
}

Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Sales Message Logger removed. Logs and config were preserved at $archiveRoot"
