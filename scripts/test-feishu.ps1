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

$proc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:3107/health" -Method Get

  if (-not $health.success) {
    throw "Health check failed."
  }

  if (-not $health.feishu.enabled) {
    throw "Feishu webhook is not enabled. Check config\feishu.local.env."
  }

  $result = Invoke-RestMethod -Uri "http://127.0.0.1:3107/test-feishu" -Method Post -ContentType "application/json" -Body "{}"

  Write-Host "Health: success=$($health.success), feishu.enabled=$($health.feishu.enabled), secretConfigured=$($health.feishu.secretConfigured)"
  Write-Host "POST /test-feishu: $($result.message)"
  Write-Host "Check the Feishu group for a test message."
} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}
