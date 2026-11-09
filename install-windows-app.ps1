$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://127.0.0.1:8787'
$edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)
$edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue
if ($edgeCommand) { $edgeCandidates += $edgeCommand.Source }
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $edgePath) {
    throw 'Microsoft Edge was not found. Install Edge, then run this installer again.'
}

$appData = Join-Path $env:LOCALAPPDATA 'Lantern Share'
$iconPath = Join-Path $appData 'lantern-share.ico'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPaths = @(
    (Join-Path $startMenu 'Lantern Share.lnk'),
    (Join-Path $desktop 'Lantern Share.lnk')
)

New-Item -ItemType Directory -Path $appData -Force | Out-Null
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null

# Convert the project logo into a Windows shortcut icon without downloading anything.
Add-Type -AssemblyName System.Drawing
$logoPath = Join-Path $projectRoot 'public\brand\lantern-mark.png'
if (-not (Test-Path -LiteralPath $logoPath)) { throw "Lantern Share logo not found at $logoPath." }
$sourceLogo = [System.Drawing.Bitmap]::new($logoPath)
$bitmap = [System.Drawing.Bitmap]::new(64, 64, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($sourceLogo, [System.Drawing.Rectangle]::new(0, 0, 64, 64))
$iconHandle = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$iconStream = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create)
try { $icon.Save($iconStream) } finally { $iconStream.Dispose() }
Add-Type -Namespace LanternShare -Name NativeIcon -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(System.IntPtr handle);
'@ -ErrorAction SilentlyContinue
[LanternShare.NativeIcon]::DestroyIcon($iconHandle) | Out-Null
$icon.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$sourceLogo.Dispose()

$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $edgePath
    $shortcut.Arguments = "--app=$url --no-first-run"
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = 'Open Lantern Share on this PC and local network.'
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Save()
}

Write-Host 'Lantern Share shortcuts with the branded icon are ready.'
Write-Host 'For a taskbar app with this icon, install Lantern Share as an Edge app from the address bar or Edge > Settings and more > Apps.'
Write-Host "It opens $url. Other devices still connect using this PC's LAN address."
Write-Host 'The share server remains local-network only.'
