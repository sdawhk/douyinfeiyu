$ErrorActionPreference = 'Stop'
$listenerCommand = [regex]::Escape((Join-Path $PSScriptRoot 'douyin_share.py'))
$listener = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $listenerCommand -and $_.CommandLine -match '--listen-inbox' } |
    Select-Object -First 1
if ($listener) {
    Write-Output 'Persistent inbox listener owns the Douyin browser; scheduled work is handled there.'
    exit 0
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual environment missing. Follow README setup first."
}
& $python (Join-Path $PSScriptRoot 'douyin_share.py') --scheduled
exit $LASTEXITCODE
