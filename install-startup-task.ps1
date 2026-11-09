$ErrorActionPreference = 'Stop'

$taskName = 'Lantern Share'
$port = 8787
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $projectRoot 'server.js'
$targetUser = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "Lantern Share was not found at $serverPath."
}

$nodeCandidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
$nodePath = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $nodePath) {
    throw 'Node.js was not found. Install Node.js 20 or newer, then run this installer again.'
}
$versionText = (& $nodePath --version | Select-Object -First 1)
if ($versionText -notmatch '^v(\d+)\.') { throw "Could not read the Node.js version from $nodePath." }
if ([int]$Matches[1] -lt 20) { throw "Lantern Share needs Node.js 20 or newer. Found $versionText." }

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installing the local-network firewall rule needs administrator access. Run this script from an elevated PowerShell window.'
}

$ruleName = 'Lantern Share - Private LAN'
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
    $existingRule | Set-NetFirewallRule -Enabled True -Profile Private
} else {
    New-NetFirewallRule -DisplayName $ruleName -Description 'Allows Lantern Share on the private local subnet only.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private -RemoteAddress LocalSubnet | Out-Null
}

$launcherPath = Join-Path $projectRoot 'start-in-background.ps1'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcherArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $launcherArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $targetUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $targetUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Description 'Starts Lantern Share in the background when this Windows account signs in.' -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host 'Lantern Share is installed and has been started in the background.'
Write-Host "It will start automatically when $targetUser signs in to Windows."
Write-Host "Join PIN: $env:LOCALAPPDATA\.lantern-share\join-pin.txt"
Write-Host "Server log: $env:LOCALAPPDATA\.lantern-share\server.log"
Write-Host "Firewall allows TCP $port from the local subnet on Private networks only."
Write-Host 'Keep this PC awake and connected to your home network while other devices need it.'
$lanAddresses = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue | Where-Object {
    $_.IPAddress -notlike '127.*' -and ($_.IPAddress.StartsWith('10.') -or $_.IPAddress.StartsWith('192.168.') -or $_.IPAddress -match '^172\.(1[6-9]|2\d|3[01])\.')
}
foreach ($address in $lanAddresses) {
    Write-Host ("Open http://{0}:{1} on other devices ({2})." -f $address.IPAddress, $port, $address.InterfaceAlias)
}
