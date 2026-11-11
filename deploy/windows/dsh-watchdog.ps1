$ErrorActionPreference = 'Stop'
$root = 'D:\deepseek'
$runner = Join-Path $root 'dsh-run.ps1'
$patcher = Join-Path $root 'patch-config-token.mjs'
$configPath = Join-Path $root 'repo\bridge\config.json'
$dshOut = Join-Path $root 'logs\dshweb.out'
$bridgeLog = Join-Path $root 'logs\bridge.log'
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

# 从 dsh web 的输出里抓本次令牌（dsh-run.ps1 每次启动都会用 FileMode.Create 清空该文件）
# 注意：dsh-run.ps1 以 FileAccess.Write + FileShare.ReadWrite 持有该文件，
# 这里必须用同样的共享模式打开，ReadAllText 会因共享冲突失败。
function Get-DshToken {
    try {
        $fs = [System.IO.File]::Open($dshOut, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
            $txt = $reader.ReadToEnd()
        } finally { $fs.Dispose() }
        $m = [regex]::Match($txt, 'token=([A-Za-z0-9_\-]+)')
        if ($m.Success) { return $m.Groups[1].Value }
    } catch { }
    return $null
}

function Get-ConfigToken {
    try {
        $cfg = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
        return [string]$cfg.dsh.launchToken
    } catch { return '' }
}

function Get-Short([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '(empty)' }
    return $value.Substring(0, [Math]::Min(8, $value.Length)) + '...'
}

function Resolve-Node {
    foreach ($p in @('C:\Program Files\nodejs\node.exe', (Join-Path $root 'snowluma\app\node.exe'))) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

# 读取 bridge.log 自某个偏移之后新增的内容，用来确认 QQ 侧已重连
function Read-Appended([string]$path, [long]$offset) {
    try {
        if (-not (Test-Path -LiteralPath $path)) { return '' }
        $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($fs.Length -le $offset) { return '' }
            [void]$fs.Seek($offset, [System.IO.SeekOrigin]::Begin)
            $buf = New-Object byte[] ($fs.Length - $offset)
            $read = $fs.Read($buf, 0, $buf.Length)
            return [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
        } finally { $fs.Dispose() }
    } catch { return '' }
}

# dsh 就绪后把新令牌写回 bridge/config.json；令牌变了才重启 qq-bot 让它重连。
function Sync-DshToken([System.Diagnostics.Process]$child) {
    $deadline = (Get-Date).AddSeconds(90)
    $token = $null
    while ((Get-Date) -lt $deadline) {
        if ($child -and $child.HasExited) {
            Write-Status 'token sync: dsh exited before ready; skip'
            return
        }
        if (Test-DshPort) {
            $token = Get-DshToken
            if ($token) { break }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $token) {
        Write-Status 'token sync: timed out waiting for dsh ready (no token in dshweb.out)'
        return
    }

    $current = Get-ConfigToken
    if ($current -eq $token) {
        Write-Status "token sync: unchanged ($(Get-Short $token)), skip qq restart"
        return
    }
    Write-Status "token sync: new token detected old=$(Get-Short $current) new=$(Get-Short $token)"

    $node = Resolve-Node
    if (-not $node) {
        Write-Status 'token sync: node runtime not found; cannot patch config'
        return
    }
    $patched = $false
    for ($i = 1; $i -le 3; $i++) {
        try {
            $out = & $node $patcher $token 2>&1
            if ((Get-ConfigToken) -eq $token) { $patched = $true; break }
            Write-Status "token sync: patch attempt $i did not take effect: $out"
        } catch {
            Write-Status "token sync: patch attempt $i failed: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 2
    }
    if (-not $patched) {
        Write-Status 'token sync: config write failed after 3 attempts; qq-bot NOT restarted'
        return
    }
    Write-Status 'token sync: config written back'

    $logOffset = 0L
    try { $logOffset = (Get-Item -LiteralPath $bridgeLog).Length } catch { }

    $botPid = $null
    try {
        $conn = Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { $botPid = $conn.OwningProcess }
    } catch { }
    if ($botPid) {
        try {
            Stop-Process -Id $botPid -Force -ErrorAction Stop
            Write-Status "token sync: qq-bot pid=$botPid stopped for reconnect"
        } catch {
            Write-Status "token sync: failed to stop qq-bot pid=$($botPid): $($_.Exception.Message)"
        }
    } else {
        Write-Status 'token sync: qq-bot not listening on 3101; waiting for bridge watchdog'
    }

    $reconnectDeadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $reconnectDeadline) {
        Start-Sleep -Seconds 3
        $appended = Read-Appended $bridgeLog $logOffset
        if ($appended -match '\[dsh\] connected' -and $appended -match '\[onebot\] login ok') {
            Write-Status 'token sync: qq reconnected (dsh connected + onebot login ok)'
            return
        }
    }
    Write-Status 'token sync: qq reconnect not confirmed within 90s'
}

# dsh 崩在写 credentials 的过程中会留下 .credentials.yaml.lock，
# 下一次启动会卡在 "atomic-write: timed out waiting for the writer lock" 并以 1 退出。
# 只在确实无人持有（能以独占方式打开）且已过期时清理，避免误删活跃锁。
function Clear-StaleCredentialLock {
    $lockPath = Join-Path $root 'dshhome\.credentials.yaml.lock'
    if (-not (Test-Path -LiteralPath $lockPath)) { return }
    try {
        $fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $fs.Dispose()
    } catch {
        return
    }
    try {
        $age = (Get-Date) - (Get-Item -LiteralPath $lockPath).LastWriteTime
        if ($age.TotalSeconds -lt 60) { return }
        [System.IO.File]::Delete($lockPath)
        Write-Status "stale credentials lock removed (age $([int]$age.TotalSeconds)s)"
    } catch {
        Write-Status "stale credentials lock cleanup failed: $($_.Exception.Message)"
    }
}

$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }

    $restarts = 0
    Write-Status 'watchdog started'
    # 启动即补一次：dsh 已在跑但 config 里还是旧令牌时，也能自愈
    if (Test-DshPort) { Sync-DshToken $null }
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
        Clear-StaleCredentialLock
        try {
            $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runner`""
            ) -WindowStyle Hidden -PassThru
            Sync-DshToken $child
            $child.WaitForExit()
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
