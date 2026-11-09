$ErrorActionPreference = 'Stop'

$shortcutPaths = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Lantern Share.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lantern Share.lnk')
)

foreach ($shortcutPath in $shortcutPaths) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
}

Write-Host 'Lantern Share app shortcuts were removed. The server, shared files, and automatic startup task were left untouched.'
