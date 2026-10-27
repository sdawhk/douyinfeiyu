# Run once from an elevated PowerShell window after updating QQ MCP tools.
# Existing watchdogs restart the bot, QQ tool service, and DSH with the new code.
$ErrorActionPreference = 'Stop'
$botPid = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess
$toolServicePid = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess
$targets = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match 'qq-bot\.mjs' -or
    ($botPid -and $_.ProcessId -eq $botPid) -or
    ($_.CommandLine -match '[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' -and $_.CommandLine -match '\bweb\s+--port\s+3090\b') -or
    ($toolServicePid -and $_.ProcessId -eq $toolServicePid)
}
if (-not $targets) {
    Write-Host 'No QQ bot, tool service, or DSH web process found. Their watchdogs may already have restarted them.'
    exit 0
}
$failed = @()
foreach ($target in $targets) {
    $name = if ($target.ProcessId -eq $botPid) { 'QQ bot' } elseif ($target.ProcessId -eq $toolServicePid) { 'QQ tool service' } elseif ($target.CommandLine -match 'qq-bot\.mjs') { 'QQ bot' } else { 'DSH web' }
    try {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        Write-Host "$name stopped (PID $($target.ProcessId)); watchdog will restart it."
    } catch {
        $failed += $target.ProcessId
        Write-Warning "$name PID $($target.ProcessId) could not be stopped: $($_.Exception.Message)"
    }
}
if ($failed.Count) {
    Write-Error "Restart could not stop PID(s): $($failed -join ', '). Run this script from an Administrator PowerShell window."
    exit 1
}
