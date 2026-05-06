$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$larkConfigPath = Join-Path $projectRoot "config\lark.local.env"

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }

  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }

  $target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue

  if ($target) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path -LiteralPath $larkConfigPath)) {
  throw "Missing config\lark.local.env."
}

Get-Content -LiteralPath $larkConfigPath | ForEach-Object {
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

  if (-not $health.larkCli.enabled) {
    throw "Lark CLI delivery is not enabled. Check config\lark.local.env."
  }

  $result = Invoke-RestMethod -Uri "http://127.0.0.1:3107/test-lark-cli" -Method Post -ContentType "application/json" -Body "{}"

  Write-Host "Health: success=$($health.success), larkCli.enabled=$($health.larkCli.enabled), chatConfigured=$($health.larkCli.chatConfigured)"
  Write-Host "POST /test-lark-cli: $($result.message)"
  Write-Host "Check Feishu for a message from the real app bot."
} finally {
  if ($proc) {
    Stop-ProcessTree -ProcessId $proc.Id
  }
}
