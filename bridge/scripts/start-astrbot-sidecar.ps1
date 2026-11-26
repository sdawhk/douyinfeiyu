$ErrorActionPreference = 'Stop'

$StateRoot = 'D:\deepseek\state\astrbot-sidecar'
$AstrBotRoot = Join-Path $StateRoot 'AstrBot'
$UvPath = Join-Path $StateRoot 'bin\uv.exe'
$PythonPath = Get-ChildItem (Join-Path $StateRoot 'python') -Directory | Where-Object { $_.Name -like 'cpython-3.12.*-windows-x86_64-none' } | Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'python.exe' }

if (-not (Test-Path $UvPath) -or -not (Test-Path (Join-Path $AstrBotRoot 'data\cmd_config.json'))) {
    throw 'Sidecar is not set up. Run setup-astrbot-sidecar.ps1 first.'
}

# Keep ordinary QQ replies in qq-bot; this sidecar only handles plugin commands.
# Windows PowerShell 5.1's JSON parser rejects some valid nested config arrays;
# use Node (also required by this installation) to parse and patch the JSON.
$sidecarConfigFile = Join-Path $AstrBotRoot 'data\cmd_config.json'
$nodePath = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { throw "Node runtime not found: $nodePath" }
$configPatcher = Join-Path $PSScriptRoot 'disable-astrbot-provider.mjs'
& $nodePath $configPatcher $sidecarConfigFile
if ($LASTEXITCODE -ne 0) { throw 'Could not validate or patch AstrBot sidecar config.' }

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
