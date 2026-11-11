$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'watchdog.log'
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Virtual environment missing. Follow README setup first." }
& $python (Join-Path $PSScriptRoot 'douyin_watchdog.py') 2>&1 |
    ForEach-Object { '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $_ } |
    Out-File -FilePath $logPath -Append -Encoding utf8
exit $LASTEXITCODE
