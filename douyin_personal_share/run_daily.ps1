$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual environment missing. Follow README setup first."
}
& $python (Join-Path $PSScriptRoot 'douyin_share.py') --scheduled
exit $LASTEXITCODE
