param(
  [switch]$NoOpenTarget,
  [string]$TargetUrl = "https://shengji.lingdongsz.com/uranus/#/afterMessage/salesConsultation"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $projectRoot "logs"
$healthUrl = "http://127.0.0.1:3107/health"
$setupUrl = "http://127.0.0.1:3107/setup"
$runtimeNode = Join-Path $projectRoot "runtime\node\node.exe"

if (!(Test-Path -LiteralPath $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

function Import-EnvFile {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path)) {
    return
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()

    if (!$line -or $line.StartsWith("#")) {
      return
    }

    $parts = $line.Split("=", 2)

    if ($parts.Count -ne 2) {
      return
    }

    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
  }
}

function Test-ServiceHealth {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    return [bool]$response.success
  } catch {
    return $false
  }
}

function Open-TargetPage {
  if ($NoOpenTarget) {
    return
  }

  try {
    Start-Process $TargetUrl
  } catch {
    Start-Process $setupUrl
  }
}

$runtimeConfigPath = Join-Path $projectRoot "config\runtime.local.json"

if (!(Test-Path -LiteralPath $runtimeConfigPath)) {
  Import-EnvFile (Join-Path $projectRoot "config\lark.local.env")
  Import-EnvFile (Join-Path $projectRoot "config\feishu.local.env")
}

if (Test-ServiceHealth) {
  Open-TargetPage
  exit 0
}

if (Test-Path -LiteralPath $runtimeNode) {
  $nodeCommand = $runtimeNode
} else {
  $nodeCommandInfo = Get-Command node -ErrorAction Stop
  $nodeCommand = $nodeCommandInfo.Source
}

$stdout = Join-Path $logsDir "listener-out.log"
$stderr = Join-Path $logsDir "listener-error.log"

Start-Process -FilePath $nodeCommand `
  -ArgumentList @("server.js") `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr

for ($attempt = 1; $attempt -le 20; $attempt += 1) {
  Start-Sleep -Seconds 1

  if (Test-ServiceHealth) {
    Open-TargetPage
    exit 0
  }
}

Start-Process $setupUrl
throw "Sales Message Logger did not become healthy at $healthUrl. Check $stderr"
