$ErrorActionPreference = "Stop"

$startScript = Join-Path $PSScriptRoot "start-installed.ps1"

if (Test-Path $startScript) {
  & $startScript
} else {
  Start-Process "http://127.0.0.1:3107/setup"
}

