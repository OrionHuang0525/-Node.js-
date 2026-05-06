$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "config\feishu.local.env"

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing config\feishu.local.env. Run: npm.cmd run setup:feishu"
}

Get-Content -LiteralPath $configPath | ForEach-Object {
  $line = $_.Trim()

  if (-not $line -or $line.StartsWith("#")) {
    return
  }

  $parts = $line.Split("=", 2)

  if ($parts.Count -ne 2) {
    return
  }

  [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
}

Write-Host "Starting Sales Message Logger with Feishu webhook config..."
node server.js
