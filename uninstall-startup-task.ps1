$ErrorActionPreference = 'Stop'

$taskName = 'Lantern Share'
$ruleName = 'Lantern Share - Private LAN'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$serverPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'server.js'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) { $existingRule | Remove-NetFirewallRule }

Write-Host 'Lantern Share will no longer start automatically.'
Write-Host 'Your saved files and share history were left in place.'
