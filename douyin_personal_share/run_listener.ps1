$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir 'listener.log'
$lockPath = Join-Path $PSScriptRoot '.browser-profile.lock'
$profilePath = Join-Path $PSScriptRoot 'browser-profile'

# The active listener keeps listener.log open for its whole lifetime (Out-File holds the
# handle), so a second instance that is refused by the mutex cannot append there. Lifecycle
# lines fall back to a dedicated file so a refusal is still recorded instead of crashing.
function Write-Log([string]$message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message
    try {
        $line | Out-File -FilePath $logPath -Append -Encoding utf8 -ErrorAction Stop
    } catch {
        $line | Out-File -FilePath (Join-Path $logDir 'listener-lifecycle.log') -Append -Encoding utf8
    }
}

# Only Edge instances started with this project's Playwright profile are ours to clean up.
function Get-ProfileBrowsers {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) }
}

# The single-instance guard above already proved that no listener is running, so every
# remaining process on this profile is a leftover: its parent may be a dead python, or a
# Playwright node driver that outlived it. Both are killed here so a hard-killed run
# cannot pile up browsers across restarts.
function Clear-ProfileBrowsers([string]$reason) {
    foreach ($proc in @(Get-ProfileBrowsers)) {
        $parentAlive = [bool](Get-Process -Id $proc.ParentProcessId -ErrorAction SilentlyContinue)
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Log ('cleaned {0} msedge {1} parent={2} parentAlive={3}' -f $reason, $proc.ProcessId, $proc.ParentProcessId, $parentAlive)
        } catch {
            # Child renderers die with their browser main process; that is success, not a failure.
            if (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue) {
                Write-Log ('could not stop {0} msedge {1}: {2}' -f $reason, $proc.ProcessId, $_.Exception.Message)
            }
        }
    }
}

# Only the python tree this script started: the direct child must be our own process.
# A graceful exit / crash lands here; a TerminateProcess does not, which is why the
# startup cleanup exists as the second line of defence.
function Clear-OwnPythonTree {
    Get-CimInstance Win32_Process -Filter "Name like '%python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*--listen-inbox*' -and $_.ParentProcessId -eq $PID } |
        ForEach-Object {
            & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null
            Write-Log ('exit cleanup: taskkill /T /F {0}' -f $_.ProcessId)
        }
}

# Named mutex: the scheduled task and a manual/legacy launch must never both pass the
# guard at the same instant. It is held for the whole run (guard + cleanup + browser),
# not just around the check, and released by the OS even after a TerminateProcess.
$mutexName = 'Local\DaFeiYu-DouyinListener'
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$ownsMutex = $false
$exitCode = 0
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) {
        Write-Log 'another listener instance already holds the mutex; exit'
        exit 0
    }

    # Second line of defence: an actual python process or a live lock holder.
    $listenerCommand = [regex]::Escape((Join-Path $PSScriptRoot 'douyin_share.py'))
    $running = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match $listenerCommand -and $_.CommandLine -match '--listen-inbox' } |
        Select-Object -First 1
    if ($running) {
        exit 0
    }
    if (Test-Path -LiteralPath $lockPath) {
        $holder = 0
        try { $holder = [int]((Get-Content -Raw -LiteralPath $lockPath).Trim()) } catch { $holder = 0 }
        if ($holder -gt 0 -and (Get-Process -Id $holder -ErrorAction SilentlyContinue)) {
            exit 0
        }
    }

    Clear-ProfileBrowsers 'startup-orphan'
    if (Test-Path -LiteralPath $lockPath) {
        $owner = 0
        try { $owner = [int]((Get-Content -Raw -LiteralPath $lockPath).Trim()) } catch { $owner = 0 }
        if ($owner -gt 0 -and -not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
            Write-Log ('removed stale profile lock owned by pid {0}' -f $owner)
        }
    }
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 10MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
    }

    $python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        throw "Virtual environment missing. Follow README setup first."
    }
    # stderr used to be discarded by Task Scheduler; keep every line with a timestamp instead.
    # -u keeps stdout unbuffered so the log is usable while the listener is still running.
    try {
        & $python -u (Join-Path $PSScriptRoot 'douyin_share.py') --listen-inbox 2>&1 |
            ForEach-Object { '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $_ } |
            Out-File -FilePath $logPath -Append -Encoding utf8
    } finally {
        Write-Log ('listener process ended (exit {0}); collecting this profile''s browsers' -f $LASTEXITCODE)
        Clear-OwnPythonTree
        Clear-ProfileBrowsers 'exit'
    }
    $exitCode = $LASTEXITCODE
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
