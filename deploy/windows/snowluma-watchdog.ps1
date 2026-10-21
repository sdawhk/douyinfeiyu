$ErrorActionPreference = 'Stop'
$appDir = 'D:\deepseek\snowluma\app'
$node = Join-Path $appDir 'node.exe'
$entry = Join-Path $appDir 'index.mjs'
$logPath = 'D:\deepseek\logs\snowluma-watchdog.log'
$heartbeatPath = 'D:\deepseek\state\snowluma-watchdog-heartbeat.txt'
$configPath = 'D:\deepseek\repo\bridge\config.json'
$mutex = [System.Threading.Mutex]::new($false, 'Local\DeepseekSnowLumaWatchdog')

function Write-Status([string]$message) {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
}

function Test-Http([string]$url, [string]$method, [string]$token) {
    try {
        $headers = @{}
        if ($token) { $headers['Authorization'] = "Bearer $token" }
        $requestArgs = @{ Uri = $url; Method = $method; Headers = $headers; TimeoutSec = 5; UseBasicParsing = $true }
        if ($method -eq 'POST') {
            $requestArgs['Body'] = '{}'
            $requestArgs['ContentType'] = 'application/json'
        }
        $response = Invoke-WebRequest @requestArgs
        if ($method -eq 'GET') { return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400 }
        $payload = $response.Content | ConvertFrom-Json
        return $payload.retcode -eq 0 -and [string]$payload.data.user_id -eq '2427256325'
    } catch {
        return $false
    }
}

function Get-SnowLumaPid {
    $listener = Get-NetTCPConnection -LocalPort 5099 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) { return 0 }
    $candidate = [int]$listener.OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate" -ErrorAction SilentlyContinue
    if ($process -and $process.ExecutablePath -ieq $node -and $process.CommandLine -match 'index\.mjs') {
        return $candidate
    }
    Write-Status "port 5099 owned by unrecognized process $candidate; refusing to stop it"
    return -1
}

function Start-SnowLuma {
    $env:SNOWLUMA_HOOK_AUTOLOAD = '1'
    $child = Start-Process -FilePath $node -ArgumentList "`"$entry`"" -WorkingDirectory $appDir -WindowStyle Hidden -PassThru
    Write-Status "SnowLuma started pid=$($child.Id)"
    return [int]$child.Id
}

$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }

    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $apiUrl = ([string]$config.snowluma.httpUrl).TrimEnd('/') + '/get_login_info'
    $apiToken = [string]$config.snowluma.httpAccessToken
    if (-not $apiToken) { $apiToken = [string]$config.snowluma.accessToken }
    $badChecks = 0
    $readyOnce = $false
    $launchedPid = 0
    $startedAt = Get-Date
    if ((Get-SnowLumaPid) -gt 0) { $startedAt = $startedAt.AddSeconds(-90) }
    Write-Status 'watchdog started'

    while ($true) {
        Set-Content -LiteralPath $heartbeatPath -Value (Get-Date -Format o)
        $pidOnPort = Get-SnowLumaPid
        if ($pidOnPort -eq -1) {
            Start-Sleep -Seconds 15
            continue
        }
        if ($pidOnPort -eq 0) {
            if ($launchedPid -gt 0 -and (Get-Process -Id $launchedPid -ErrorAction SilentlyContinue)) {
                if (((Get-Date) - $startedAt).TotalSeconds -lt 90) {
                    Start-Sleep -Seconds 15
                    continue
                }
                Stop-Process -Id $launchedPid -Force -ErrorAction SilentlyContinue
                Write-Status "SnowLuma startup timed out pid=$launchedPid"
            }
            $launchedPid = Start-SnowLuma
            $startedAt = Get-Date
            $badChecks = 0
            Start-Sleep -Seconds 20
            continue
        }

        $uiOk = Test-Http 'http://127.0.0.1:5099/' 'GET' ''
        $qqOk = Test-Http $apiUrl 'POST' $apiToken
        if ($uiOk -and $qqOk) {
            if (-not $readyOnce -or $badChecks) { Write-Status "SnowLuma healthy pid=$pidOnPort" }
            $readyOnce = $true
            $badChecks = 0
        } elseif (((Get-Date) - $startedAt).TotalSeconds -ge 90) {
            $badChecks++
            Write-Status "health failed pid=$pidOnPort ui=$uiOk qq=$qqOk count=$badChecks"
            # A healthy UI with QQ logged out may need manual login; restarting
            # repeatedly would make that harder. Restart only a stalled server.
            if ($badChecks -ge 3 -and -not $uiOk) {
                try {
                    Stop-Process -Id $pidOnPort -Force -ErrorAction Stop
                    Write-Status "stalled SnowLuma stopped pid=$pidOnPort"
                    Start-Sleep -Seconds 3
                    $launchedPid = Start-SnowLuma
                    $startedAt = Get-Date
                    $badChecks = 0
                } catch {
                    Write-Status "restart failed: $($_.Exception.Message)"
                }
            }
        }
        Start-Sleep -Seconds 15
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
