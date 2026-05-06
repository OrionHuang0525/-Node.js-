$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$distRoot = Join-Path $projectRoot "dist"
$packageRoot = Join-Path $distRoot "SalesMessageLoggerPackage"
$exePath = Join-Path $distRoot "SalesMessageLogger-Setup.exe"
$sedPath = Join-Path $distRoot "sales-message-logger.sed"

if (Test-Path $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

$excludeDirs = @("\.git", "\dist", "\logs")
$excludeFiles = @(
  "\config\feishu.local.env",
  "\config\lark.local.env",
  "\config\runtime.local.json"
)

Get-ChildItem -Path $projectRoot -Recurse -Force | ForEach-Object {
  $relative = $_.FullName.Substring($projectRoot.Length)
  $skip = $false

  foreach ($exclude in $excludeDirs) {
    if ($relative -like "$exclude*") {
      $skip = $true
      break
    }
  }

  if (!$skip) {
    foreach ($exclude in $excludeFiles) {
      if ($relative -ieq $exclude) {
        $skip = $true
        break
      }
    }
  }

  if (!$skip) {
    $target = Join-Path $packageRoot $relative.TrimStart("\")

    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

New-Item -ItemType Directory -Path (Join-Path $packageRoot "logs") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $packageRoot "logs\.gitkeep") -Force | Out-Null

$nodeExe = Join-Path $packageRoot "runtime\node\node.exe"
if (!(Test-Path $nodeExe)) {
  $currentNode = Get-Command node -ErrorAction SilentlyContinue
  if ($currentNode -and (Test-Path $currentNode.Source)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $nodeExe) -Force | Out-Null
    Copy-Item -LiteralPath $currentNode.Source -Destination $nodeExe -Force
    Write-Host "Bundled Node runtime: $($currentNode.Source)"
  } else {
    Write-Warning "Portable Node runtime was not found and system node.exe could not be located. This package will require Node on the target machine."
  }
}

$bootstrapRoot = Join-Path $distRoot "iexpress-bootstrap"
$payloadZip = Join-Path $bootstrapRoot "payload.zip"
$bootstrapScript = Join-Path $bootstrapRoot "install-from-payload.ps1"

if (Test-Path $bootstrapRoot) {
  Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $bootstrapRoot -Force | Out-Null

Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $payloadZip -Force

@'
$ErrorActionPreference = "Stop"

$extractRoot = Join-Path $env:TEMP ("SalesMessageLoggerSetup-" + [Guid]::NewGuid().ToString("N"))
$payload = Join-Path $PSScriptRoot "payload.zip"

New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
Expand-Archive -LiteralPath $payload -DestinationPath $extractRoot -Force

$installScript = Join-Path $extractRoot "installer\install.ps1"
if (!(Test-Path $installScript)) {
  throw "Installer payload is incomplete: installer\install.ps1 was not found."
}

& $installScript
'@ | Set-Content -Path $bootstrapScript -Encoding UTF8

$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
if (!(Test-Path $iexpress)) {
  Write-Warning "IExpress is not available. Package folder created at $packageRoot"
  exit 0
}

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=Sales Message Logger installed.
TargetName=$exePath
FriendlyName=Sales Message Logger Setup
AppLaunched=powershell.exe -ExecutionPolicy Bypass -File install-from-payload.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="install-from-payload.ps1"
FILE1="payload.zip"
[SourceFiles]
SourceFiles0=$bootstrapRoot
[SourceFiles0]
%FILE0%=
%FILE1%=
"@

Set-Content -Path $sedPath -Value $sed -Encoding ASCII
Remove-Item -LiteralPath $exePath -Force -ErrorAction SilentlyContinue
$iexpressProcess = Start-Process -FilePath $iexpress -ArgumentList @("/N", "/Q", $sedPath) -Wait -PassThru -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 60 -and !(Test-Path $exePath); $attempt += 1) {
  Start-Sleep -Milliseconds 500
}

if (Test-Path $exePath) {
  Write-Host "Installer created: $exePath"
} else {
  Write-Warning "IExpress finished but installer was not found. Package folder remains at $packageRoot"
}
