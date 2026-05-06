$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$larkConfigPath = Join-Path $projectRoot "config\lark.local.env"
$feishuConfigPath = Join-Path $projectRoot "config\feishu.local.env"

function Import-EnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
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
}

if (-not (Test-Path -LiteralPath $larkConfigPath)) {
  throw "Missing config\lark.local.env."
}

Import-EnvFile $larkConfigPath
Import-EnvFile $feishuConfigPath

Write-Host "Starting Sales Message Logger with real Lark CLI app delivery..."
node server.js
