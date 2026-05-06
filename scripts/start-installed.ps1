param(
  [switch]$NoOpenSetup
)

$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logsDir = Join-Path $installRoot "logs"
$nodeExe = Join-Path $installRoot "runtime\node\node.exe"

if (!(Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

function Test-ServiceHealth {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:3107/health" -TimeoutSec 2
    return [bool]$response.success
  } catch {
    return $false
  }
}

if (Test-ServiceHealth) {
  if (!$NoOpenSetup) {
    Start-Process "http://127.0.0.1:3107/setup"
  }
  exit 0
}

if (Test-Path $nodeExe) {
  $nodeCommand = $nodeExe
} else {
  $nodeCommand = "node"
}

$stdout = Join-Path $logsDir "service-out.log"
$stderr = Join-Path $logsDir "service-error.log"

Start-Process -FilePath $nodeCommand `
  -ArgumentList @("server.js") `
  -WorkingDirectory $installRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr

Start-Sleep -Seconds 2

if (!$NoOpenSetup) {
  Start-Process "http://127.0.0.1:3107/setup"
}

