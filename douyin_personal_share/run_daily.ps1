$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'scheduled.log'
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
}
$listenerCommand = [regex]::Escape((Join-Path $PSScriptRoot 'douyin_share.py'))
$listener = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $listenerCommand -and $_.CommandLine -match '--listen-inbox' } |
    Select-Object -First 1
if ($listener) {
    Write-Output 'Persistent inbox listener owns the Douyin browser; scheduled work is handled there.'
    exit 0
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Virtual environment missing. Follow README setup first." }
# Task Scheduler discards stderr, so keep it next to stdout in a timestamped log file.
& $python -u (Join-Path $PSScriptRoot 'douyin_share.py') --scheduled 2>&1 |
    ForEach-Object { '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $_ } |
    Out-File -FilePath $logPath -Append -Encoding utf8
exit $LASTEXITCODE
