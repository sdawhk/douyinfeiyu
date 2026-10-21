$ErrorActionPreference = 'Stop'
$root = 'D:\deepseek'
$runner = Join-Path $root 'dsh-run.ps1'
$logPath = Join-Path $root 'logs\dsh-watchdog.log'
$mutex = [System.Threading.Mutex]::new($false, 'Local\DeepseekDshWatchdog')

function Write-Status([string]$message) {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
}

function Test-DshPort {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect('127.0.0.1', 3090, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }

    $restarts = 0
    Write-Status 'watchdog started'
    while ($true) {
        if (Test-DshPort) {
            Start-Sleep -Seconds 10
            continue
        }
        if (-not (Test-Path -LiteralPath $runner)) {
            Write-Status 'runner missing; retrying in 10s'
            Start-Sleep -Seconds 10
            continue
        }
        $restarts++
        Write-Status "DSH offline; launch attempt $restarts"
        try {
            $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runner`""
            ) -WindowStyle Hidden -PassThru -Wait
            Write-Status "DSH exited with code $($child.ExitCode); retrying in 5s"
        } catch {
            Write-Status "DSH launch failed: $($_.Exception.Message); retrying in 5s"
        }
        Start-Sleep -Seconds 5
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
