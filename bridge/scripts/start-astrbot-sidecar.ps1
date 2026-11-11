$ErrorActionPreference = 'Stop'

$StateRoot = 'D:\deepseek\state\astrbot-sidecar'
$AstrBotRoot = Join-Path $StateRoot 'AstrBot'
$UvPath = Join-Path $StateRoot 'bin\uv.exe'
$PythonPath = Get-ChildItem (Join-Path $StateRoot 'python') -Directory | Where-Object { $_.Name -like 'cpython-3.12.*-windows-x86_64-none' } | Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'python.exe' }

if (-not (Test-Path $UvPath) -or -not (Test-Path (Join-Path $AstrBotRoot 'data\cmd_config.json'))) {
    throw 'Sidecar is not set up. Run setup-astrbot-sidecar.ps1 first.'
}

$env:UV_CACHE_DIR = Join-Path $StateRoot 'cache'
$env:TMP = Join-Path $StateRoot 'tmp'
$env:TEMP = $env:TMP
$env:ASTRBOT_ROOT = $AstrBotRoot
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null

Push-Location $AstrBotRoot
try {
    & $UvPath run --no-sync --python $PythonPath main.py
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
