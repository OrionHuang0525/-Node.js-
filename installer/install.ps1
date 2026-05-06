param(
  [switch]$NoAutoStart
)

$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installRoot = Join-Path $env:LOCALAPPDATA "SalesMessageLogger"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Sales Message Logger"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Sales Message Logger.lnk"
$setupShortcut = Join-Path $startMenuDir "Sales Message Logger.lnk"
$uninstallShortcut = Join-Path $startMenuDir "Uninstall Sales Message Logger.lnk"
$taskName = "SalesMessageLogger"

Write-Host "Installing Sales Message Logger to $installRoot"

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null

$excludeDirs = @("\.git", "\dist", "\logs")
$excludeFiles = @(
  "\config\feishu.local.env",
  "\config\lark.local.env",
  "\config\runtime.local.json"
)

Get-ChildItem -Path $sourceRoot -Recurse -Force | ForEach-Object {
  $relative = $_.FullName.Substring($sourceRoot.Length)
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
    $target = Join-Path $installRoot $relative.TrimStart("\")

    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

New-Item -ItemType Directory -Path (Join-Path $installRoot "logs") -Force | Out-Null

function New-Shortcut {
  param(
    [string]$Path,
    [string]$TargetPath,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$Description
  )

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = $Description
  $shortcut.Save()
}

$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$openSetupScript = Join-Path $installRoot "scripts\open-setup.ps1"
$uninstallScript = Join-Path $installRoot "installer\uninstall.ps1"

New-Shortcut `
  -Path $desktopShortcut `
  -TargetPath $powershell `
  -Arguments "-ExecutionPolicy Bypass -File `"$openSetupScript`"" `
  -WorkingDirectory $installRoot `
  -Description "Open Sales Message Logger setup wizard"

New-Shortcut `
  -Path $setupShortcut `
  -TargetPath $powershell `
  -Arguments "-ExecutionPolicy Bypass -File `"$openSetupScript`"" `
  -WorkingDirectory $installRoot `
  -Description "Open Sales Message Logger setup wizard"

New-Shortcut `
  -Path $uninstallShortcut `
  -TargetPath $powershell `
  -Arguments "-ExecutionPolicy Bypass -File `"$uninstallScript`"" `
  -WorkingDirectory $installRoot `
  -Description "Uninstall Sales Message Logger"

if (!$NoAutoStart) {
  $startScript = Join-Path $installRoot "scripts\start-installed.ps1"
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -NoOpenSetup"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

& (Join-Path $installRoot "scripts\start-installed.ps1")

Write-Host "Install complete. Setup wizard: http://127.0.0.1:3107/setup"
