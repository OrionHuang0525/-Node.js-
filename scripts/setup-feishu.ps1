$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $projectRoot "config"
$configPath = Join-Path $configDir "feishu.local.env"

New-Item -ItemType Directory -Path $configDir -Force | Out-Null

Write-Host ""
Write-Host "Sales Message Logger - Feishu setup"
Write-Host "Paste the custom bot webhook URL from your Feishu group."
Write-Host "The value will be saved locally to config\feishu.local.env and ignored by git."
Write-Host ""

$webhook = Read-Host "FEISHU_WEBHOOK_URL"
$webhook = $webhook.Trim()

if ([string]::IsNullOrWhiteSpace($webhook)) {
  throw "FEISHU_WEBHOOK_URL cannot be empty."
}

if ($webhook -notmatch "^https://open\.feishu\.cn/open-apis/bot/v2/hook/" -and $webhook -notmatch "^https://open\.larksuite\.com/open-apis/bot/v2/hook/") {
  Write-Warning "This does not look like a standard Feishu/Lark custom bot webhook URL. It will still be saved."
}

$secret = Read-Host "FEISHU_SECRET (optional, press Enter if the bot has no signature verification)"
$timeoutMs = Read-Host "FEISHU_TIMEOUT_MS (optional, default 10000)"

if ([string]::IsNullOrWhiteSpace($timeoutMs)) {
  $timeoutMs = "10000"
}

if ($timeoutMs -notmatch "^\d+$") {
  throw "FEISHU_TIMEOUT_MS must be a number."
}

$content = @(
  "FEISHU_WEBHOOK_URL=$webhook",
  "FEISHU_SECRET=$($secret.Trim())",
  "FEISHU_TIMEOUT_MS=$timeoutMs"
) -join [Environment]::NewLine

Set-Content -LiteralPath $configPath -Value $content -Encoding UTF8

Write-Host ""
Write-Host "Saved: $configPath"
Write-Host "Next:"
Write-Host "  npm.cmd run test:feishu"
Write-Host "  npm.cmd run start:feishu"
