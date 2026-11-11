$ErrorActionPreference = 'Stop'

$StateRoot = 'D:\deepseek\state\astrbot-sidecar'
$AstrBotRoot = Join-Path $StateRoot 'AstrBot'
$PluginSources = @(
    @{ Name = 'astrbot_plugin_qq_group_daily_analysis'; Url = 'https://github.com/SXP-Simon/astrbot_plugin_qq_group_daily_analysis.git'; Commit = '0cf0dbd42d9962898ea3cd22b1535c02efb9d65b' },
    @{ Name = 'astrbot_plugin_pet'; Url = 'https://github.com/DITF16/astrbot_plugin_pet.git'; Commit = '89506e5cec172f6f47cbd8b89052b42e803d025b' }
)
$UpstreamRoot = Join-Path $StateRoot 'upstream'
$PluginRoot = Join-Path $AstrBotRoot 'data\plugins'
$UvPath = Join-Path $StateRoot 'bin\uv.exe'
$PyRoot = Join-Path $StateRoot 'python'
$CacheRoot = Join-Path $StateRoot 'cache'
$TempRoot = Join-Path $StateRoot 'tmp'

New-Item -ItemType Directory -Force -Path $StateRoot, (Split-Path $UvPath), $PyRoot, $CacheRoot, $TempRoot, $UpstreamRoot | Out-Null
$env:UV_CACHE_DIR = $CacheRoot
$env:TMP = $TempRoot
$env:TEMP = $TempRoot

if (-not (Test-Path $UvPath)) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/astral-sh/uv/releases/tags/0.13.7'
    $asset = $release.assets | Where-Object { $_.name -eq 'uv-x86_64-pc-windows-msvc.zip' } | Select-Object -First 1
    if (-not $asset) { throw 'Could not find the pinned uv Windows release asset.' }
    $archive = Join-Path $StateRoot 'uv.zip'
    Invoke-WebRequest $asset.browser_download_url -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath (Split-Path $UvPath) -Force
    Remove-Item -LiteralPath $archive
}

if (-not (Test-Path (Join-Path $AstrBotRoot 'main.py'))) {
    git clone --depth 1 --branch v4.29.4 https://github.com/AstrBotDevs/AstrBot.git $AstrBotRoot
}

& $UvPath python install 3.12 --install-dir $PyRoot
$PythonPath = Get-ChildItem $PyRoot -Directory | Where-Object { $_.Name -like 'cpython-3.12.*-windows-x86_64-none' } | Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'python.exe' }
if (-not (Test-Path $PythonPath)) { throw 'The isolated Python 3.12 interpreter was not found.' }

Push-Location $AstrBotRoot
try {
    & $UvPath sync --python $PythonPath
    if ($LASTEXITCODE -ne 0) { throw 'AstrBot dependency installation failed.' }
    & $UvPath pip install --python (Join-Path $AstrBotRoot '.venv\Scripts\python.exe') diskcache ulid-py 'typst>=0.15.0,<0.16'
    if ($LASTEXITCODE -ne 0) { throw 'The daily analysis plugin dependencies could not be installed.' }
    $env:ASTRBOT_ROOT = $AstrBotRoot
    $configPath = Join-Path $AstrBotRoot 'data\cmd_config.json'
    if (-not (Test-Path $configPath)) {
        $initialPassword = [guid]::NewGuid().ToString('N')
        Set-Content -LiteralPath (Join-Path $StateRoot 'dashboard-initial-password.txt') -Value $initialPassword -NoNewline
        $env:ASTRBOT_DASHBOARD_INITIAL_PASSWORD = $initialPassword
        & $UvPath run --no-sync --python $PythonPath astrbot init --yes
        if ($LASTEXITCODE -ne 0) { throw 'AstrBot data initialization failed.' }
    }
} finally {
    Remove-Item Env:ASTRBOT_DASHBOARD_INITIAL_PASSWORD -ErrorAction SilentlyContinue
    Remove-Variable initialPassword -ErrorAction SilentlyContinue
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $PluginRoot | Out-Null
foreach ($plugin in $PluginSources) {
    $source = Join-Path $UpstreamRoot $plugin.Name
    if (-not (Test-Path (Join-Path $source '.git'))) {
        git clone --filter=blob:none --no-checkout $plugin.Url $source
        if ($LASTEXITCODE -ne 0) { throw "Could not clone $($plugin.Name)." }
        git -C $source fetch --depth 1 origin $plugin.Commit
        if ($LASTEXITCODE -ne 0) { throw "Could not fetch pinned commit for $($plugin.Name)." }
        git -C $source checkout --detach $plugin.Commit
        if ($LASTEXITCODE -ne 0) { throw "Could not check out pinned commit for $($plugin.Name)." }
    }
    if (-not (Test-Path (Join-Path $source 'main.py'))) { throw "Plugin source missing: $source" }
    $destination = Join-Path $PluginRoot $plugin.Name
    if (-not (Test-Path $destination)) {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Exclude '.git'
    }
}

$petMetadata = Join-Path $PluginRoot 'astrbot_plugin_pet\metadata.yaml'
if (Test-Path $petMetadata) {
    $metadataText = Get-Content -LiteralPath $petMetadata -Raw
    $metadataText = $metadataText -replace '(?m)^version:\s*1\.6\s*$', 'version: "1.6"'
    Set-Content -LiteralPath $petMetadata -Value $metadataText -Encoding utf8
}

$configPath = Join-Path $AstrBotRoot 'data\cmd_config.json'
if (-not (Test-Path $configPath)) { throw 'AstrBot config was not initialized.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$credentialPath = Join-Path $StateRoot 'dashboard-initial-password.txt'
if (-not (Test-Path $credentialPath)) {
    $credentialCode = @'
import json, os, sys
sys.path.insert(0, os.environ["ASTRBOT_ROOT"])
from astrbot.core.utils.auth_password import generate_dashboard_password, hash_dashboard_password, hash_md5_dashboard_password
password = generate_dashboard_password()
print(json.dumps({"password": password, "pbkdf2": hash_dashboard_password(password), "md5": hash_md5_dashboard_password(password)}))
'@
    $credentialJson = (& (Join-Path $AstrBotRoot '.venv\Scripts\python.exe') -c $credentialCode) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate the local dashboard credential.' }
    $credential = $credentialJson | ConvertFrom-Json
    Set-Content -LiteralPath $credentialPath -Value $credential.password -NoNewline
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $credentialPath -AclObject $acl
    (Get-Item $credentialPath).Attributes = 'Hidden'
    $config.dashboard.password = $credential.md5
    $config.dashboard.pbkdf2_password = $credential.pbkdf2
    $config.dashboard.password_storage_upgraded = $true
    $config.dashboard.password_change_required = $false
}
$config.dashboard.host = '127.0.0.1'
$config.dashboard.port = 6186
$config.wake_prefix = @('!', '/')
$config.provider_settings.enable = $false
$config.disable_builtin_commands = $true
$config.log_level = 'WARN'
$config.plugin_set = @('astrbot_plugin_pet', 'astrbot_plugin_qq_group_daily_analysis')
$config.platform = @([pscustomobject]@{
    id = 'snowluma'
    type = 'aiocqhttp'
    enable = $true
    ws_reverse_host = '127.0.0.1'
    ws_reverse_port = 6199
    ws_reverse_token = ''
})
$provider = [pscustomobject]@{
    id = 'local-modelpool'
    provider_source_id = 'local-modelpool-source'
    provider = 'openai'
    type = 'openai_chat_completion'
    provider_type = 'chat_completion'
    enable = $true
    key = @('local-sidecar')
    api_base = 'http://127.0.0.1:18901/v1'
    model = 'deepseek-v4.1-flash-free'
    timeout = 120
    proxy = ''
    custom_headers = [pscustomobject]@{}
}
$providerSource = [pscustomobject]@{
    id = 'local-modelpool-source'
    provider = 'openai'
    type = 'openai_chat_completion'
    provider_type = 'chat_completion'
    enable = $true
    key = @('local-sidecar')
    api_base = 'http://127.0.0.1:18901/v1'
    timeout = 120
    proxy = ''
    custom_headers = [pscustomobject]@{}
}
$config.provider = @($config.provider | Where-Object { $_.id -ne 'local-modelpool' }) + $provider
$config.provider_sources = @($config.provider_sources | Where-Object { $_.id -ne 'local-modelpool-source' }) + $providerSource
$config.agent_runner.config.model.provider_id = 'local-modelpool'
$bridgeConfigPath = 'D:\deepseek\repo\bridge\config.json'
if (Test-Path $bridgeConfigPath) {
    $bridgeConfig = Get-Content -LiteralPath $bridgeConfigPath -Raw | ConvertFrom-Json
    $ownerId = [string]$bridgeConfig.ownerQQ
    if ($ownerId -and $config.admins_id -notcontains $ownerId) {
        $config.admins_id = @($config.admins_id) + $ownerId
    }
}
$config | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $configPath -Encoding utf8

Write-Host "AstrBot sidecar prepared at $AstrBotRoot (Python 3.12; dashboard 127.0.0.1:6186; OneBot reverse WS 127.0.0.1:6199)."



