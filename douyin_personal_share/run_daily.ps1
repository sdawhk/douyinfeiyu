$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'scheduled.log'
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
}
# Match by COMMAND LINE, not by process name: the venv python.exe shim re-execs the real
# interpreter as python3.12.exe, so a name filter misses the live listener and this task
# would open a second browser on the same profile every 15 minutes, killing the listener.
$listenerCommand = [regex]::Escape((Join-Path $PSScriptRoot 'douyin_share.py'))
$listener = Get-CimInstance Win32_Process -Filter "Name LIKE '%python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $listenerCommand -and $_.CommandLine -match '--listen-inbox' } |
    Select-Object -First 1
if ($listener) {
    Write-Output 'Persistent inbox listener owns the Douyin browser; scheduled work is handled there.'
    exit 0
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Virtual environment missing. Follow README setup first." }
# Task Scheduler discards stderr, so keep it next to stdout in a timestamped log file.
# Same PS 5.1 hazard as run_listener.ps1: with EAP=Stop the first stderr line
# hard-kills python (-1). Relax EAP around the pipeline so stderr just gets logged.
$pipelineEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $python -u (Join-Path $PSScriptRoot 'douyin_share.py') --scheduled 2>&1 |
        ForEach-Object { '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $_ } |
        Out-File -FilePath $logPath -Append -Encoding utf8
} finally {
    $ErrorActionPreference = $pipelineEap
}
exit $LASTEXITCODE
