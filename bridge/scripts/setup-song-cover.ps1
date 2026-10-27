param([string]$Target = 'D:\deepseek\state\singing-rvc')

$ErrorActionPreference = 'Stop'
$pythonHomeFile = Join-Path $Target 'python-home.txt'
$sitePackages = Join-Path $Target 'venv\Lib\site-packages'
$ffmpeg = Join-Path $Target 'ffmpeg\bin\ffmpeg.exe'
if (-not (Test-Path $pythonHomeFile)) { throw "先安装流萤 RVC 环境：$pythonHomeFile" }
if (-not (Test-Path $ffmpeg)) { throw "缺少 ffmpeg：$ffmpeg" }
$python = Join-Path ((Get-Content $pythonHomeFile -Raw).Trim()) 'python.exe'
if (-not (Test-Path $python)) { throw "Python 不存在：$python" }
New-Item -ItemType Directory -Force $sitePackages | Out-Null
if (-not (Test-Path (Join-Path $sitePackages 'yt_dlp'))) {
  & $python -m pip install --disable-pip-version-check --no-deps --index-url https://pypi.org/simple --target $sitePackages yt-dlp==2026.10.21
  if ($LASTEXITCODE -ne 0) { throw 'yt-dlp 安装失败' }
}
$rvcCode = Join-Path $Target 'sing\rvc_cli'
$env:PYTHONPATH = "$sitePackages;$rvcCode;$env:PYTHONPATH"
$env:HF_HOME = Join-Path $Target 'cache\huggingface'
$env:PATH = "$(Split-Path $ffmpeg);$env:PATH"
& $python -c 'from demucs.api import Separator; from rvc_cli.rvc.infer.infer import VoiceConverter'
if ($LASTEXITCODE -ne 0) {
  # 早期的 RVC 环境可能有包元数据，却缺少实际模块；强制修复这些推理依赖。
  & $python -m pip install --disable-pip-version-check --no-deps --upgrade --index-url https://pypi.org/simple --target $sitePackages `
    sphn==0.2.1 tqdm==4.70.1 soupsieve==3.0.4 torch-einops-utils==0.1.44 scipy==1.18.1 `
    soundfile==0.14.0 soxr==1.1.0 urllib3==2.8.0 threadpoolctl==3.7.0 PyYAML==6.0.3 `
    torchcrepe==0.0.24 wget==3.2 libf0==1.1.1 torchfcpe==0.0.4 transformers==4.46.3 tokenizers==0.20.3
  if ($LASTEXITCODE -ne 0) { throw '流萤 RVC 依赖修复失败' }
}
& $python -m yt_dlp --version
if ($LASTEXITCODE -ne 0) { throw 'yt-dlp 校验失败' }
& $python -c 'from demucs.api import Separator; from rvc_cli.rvc.infer.infer import VoiceConverter'
if ($LASTEXITCODE -ne 0) { throw '流萤 RVC 校验失败' }
Write-Host "现成歌曲点唱依赖已就绪：$Target"
