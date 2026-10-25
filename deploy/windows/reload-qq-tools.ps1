# Run once from an elevated PowerShell window after updating QQ MCP tools.
# Existing watchdogs restart both processes with the new code.
$ErrorActionPreference = 'Stop'
$targets = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match 'qq-bot\.mjs' -or
    ($_.CommandLine -match '[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' -and $_.CommandLine -match '\bweb\s+--port\s+3090\b')
}
if (-not $targets) {
    Write-Host 'No QQ bot or DSH web process found. Their watchdogs may already have restarted them.'
    exit 0
}
foreach ($target in $targets) {
    $name = if ($target.CommandLine -match 'qq-bot\.mjs') { 'QQ bot' } else { 'DSH web' }
    Stop-Process -Id $target.ProcessId -Force
    Write-Host "$name stopped (PID $($target.ProcessId)); watchdog will restart it."
}
