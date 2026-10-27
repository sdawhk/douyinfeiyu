param(
  [Parameter(Mandatory = $true)][string]$Python,
  [string]$SkillPackage = 'C:\Users\admin\Desktop\流萤音色语音加唱歌技能包4.0\dafish-sing-skill-20261023',
  [string]$Target = 'D:\deepseek\state\singing-rvc'
)

$ErrorActionPreference = 'Stop'
$pythonRoot = Split-Path -Parent $Python
$env:PATH = "$pythonRoot;$pythonRoot\DLLs;$env:PATH"
$sing = Join-Path $Target 'sing'
$pythonHomeFile = Join-Path $Target 'python-home.txt'
[IO.File]::WriteAllText($pythonHomeFile, $pythonRoot, (New-Object System.Text.UTF8Encoding($false)))
$ffmpegDir = Join-Path $Target 'ffmpeg\bin'
$ffmpegExe = Join-Path $ffmpegDir 'ffmpeg.exe'
if (-not (Test-Path $ffmpegExe)) {
  $archive = Join-Path $Target 'ffmpeg-release-essentials.zip'
  $extractDir = Join-Path $Target 'ffmpeg-extract'
  Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $archive
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba') { throw 'FFmpeg archive SHA256 does not match the published checksum.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
  New-Item -ItemType Directory -Force $ffmpegDir | Out-Null
  $sourceFfmpeg = Get-ChildItem -LiteralPath $extractDir -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
  if (-not $sourceFfmpeg) { throw 'FFmpeg executable was missing from the downloaded archive.' }
  Copy-Item -LiteralPath $sourceFfmpeg.FullName -Destination $ffmpegExe -Force
  Remove-Item -LiteralPath $archive -Force
  Remove-Item -LiteralPath $extractDir -Recurse -Force
}
$srcPayload = Join-Path $SkillPackage 'payload\sing'
$srcModels = Join-Path $SkillPackage 'models\sing'
if (-not (Test-Path $Python)) { throw "Python 不存在：$Python" }
if (-not (Test-Path (Join-Path $srcPayload 'cover.py'))) { throw "技能包不完整：$srcPayload" }
New-Item -ItemType Directory -Force $sing | Out-Null
Copy-Item (Join-Path $srcPayload '*') $sing -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $sing 'model') | Out-Null
Copy-Item (Join-Path $srcModels 'model\liuying.pth') (Join-Path $sing 'model\liuying.pth') -Force
$contentvec = Join-Path $sing 'model\rvc\models\embedders\contentvec'
New-Item -ItemType Directory -Force $contentvec | Out-Null
Copy-Item (Join-Path $srcModels 'rvc\models\embedders\contentvec\*') $contentvec -Recurse -Force
Copy-Item (Join-Path $srcModels 'rvc_cli\rvc\models\predictors\rmvpe.pt') (Join-Path $sing 'model\rmvpe.pt') -Force

$venvPython = Join-Path $Target 'venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) { & $Python -m venv --without-pip (Join-Path $Target 'venv') }
$sitePackages = Join-Path $Target 'venv\Lib\site-packages'
New-Item -ItemType Directory -Force $sitePackages | Out-Null
$env:PYTHONPATH = "$sitePackages;$env:PYTHONPATH"
$requirements = Join-Path $sing 'requirements.txt'
$filtered = Join-Path $Target 'requirements.cpu.txt'
[IO.File]::WriteAllText((Join-Path $Target 'constraints.cpu.txt'), "torch==2.5.1+cpu`ntorchaudio==2.5.1+cpu", (New-Object System.Text.UTF8Encoding($false)))
(Get-Content $requirements | Where-Object { $_ -notmatch '^\s*(torch|torchaudio)\s*=' }) | Set-Content -Encoding utf8 $filtered
& $Python -m pip install --upgrade --target $sitePackages --extra-index-url https://download.pytorch.org/whl/cpu --constraint (Join-Path $Target 'constraints.cpu.txt') -r $filtered
if ($LASTEXITCODE -ne 0) { throw "RVC dependency installation failed." }
& $Python -c "import torch, demucs; print(torch.__version__); print(torch.cuda.is_available())"
if ($LASTEXITCODE -ne 0) { throw "RVC dependency import failed." }
& $ffmpegExe -version | Select-Object -First 1
Write-Host "流萤 RVC 文件已准备：$Target"
