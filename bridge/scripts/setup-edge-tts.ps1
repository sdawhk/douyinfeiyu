# 本机 Edge TTS 环境安装：在 state\edge-tts\venv 里准备 Python edge-tts，
# 让 18902 的 /v1/audio/speech 直连微软端点合成，不再依赖 workers.dev。
# 用法：powershell -ExecutionPolicy Bypass -File setup-edge-tts.ps1
# 注意：这台机器的用户级 HTTP_PROXY 指向经常不运行的 127.0.0.1:12450，
# pip 走它会卡死，所以全程清代理、用 Node fetch 拉 wheel 后手工解包。

$ErrorActionPreference = 'Stop'
$root = 'D:\deepseek'
$envDir = Join-Path $root 'state\edge-tts\venv'
$wheelDir = Join-Path $root 'tmp\edgetts-tmp\wheels'
$node = Join-Path $root 'snowluma\app\node.exe'

foreach ($v in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy') { Remove-Item "env:$v" -ErrorAction SilentlyContinue }

if (-not (Test-Path $node)) { throw "找不到 Node：$node" }
$basePy = (Get-Command python -ErrorAction Stop).Source

Write-Host "== 1/4 创建 venv =="
if (-not (Test-Path (Join-Path $envDir 'Scripts\python.exe'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $envDir) | Out-Null
  & $basePy -m venv $envDir
  # ensurepip 在无 pip wheel 的 runtime 上会失败，但 venv 本体已可用，继续。
  if (-not (Test-Path (Join-Path $envDir 'Scripts\python.exe'))) { throw 'venv 创建失败' }
}

Write-Host "== 2/4 下载 wheel（Node fetch，绕开 pip 代理问题）=="
New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null
& $node (Join-Path $PSScriptRoot 'fetch-edge-tts-wheels.mjs')
if ($LASTEXITCODE -ne 0) { throw 'wheel 下载失败' }

Write-Host "== 3/4 解包到 venv site-packages =="
$site = Join-Path $envDir 'Lib\site-packages'
New-Item -ItemType Directory -Force -Path $site | Out-Null
foreach ($w in Get-ChildItem (Join-Path $wheelDir '*.whl')) {
  $zip = Join-Path $wheelDir ($w.BaseName + '.zip')
  Copy-Item $w.FullName $zip -Force
  Expand-Archive -Path $zip -DestinationPath $site -Force
  Remove-Item $zip -Force
}

Write-Host "== 4/4 冒烟测试：合成一句语音 =="
$testTxt = Join-Path $root 'tmp\edgetts-tmp\setup-test.txt'
$testMp3 = Join-Path $root 'tmp\edgetts-tmp\setup-test.mp3'
Set-Content -Path $testTxt -Value '本机 Edge TTS 环境安装完成。' -Encoding UTF8
& (Join-Path $envDir 'Scripts\python.exe') -m edge_tts --voice zh-CN-XiaoxiaoNeural --file $testTxt --write-media $testMp3
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $testMp3) -or (Get-Item $testMp3).Length -lt 1024) {
  throw '冒烟测试失败：请检查网络能否直连 speech.platform.bing.com'
}
Remove-Item $testTxt, $testMp3 -Force -ErrorAction SilentlyContinue

Write-Host "完成。重启 18902 服务后生效（start-bot.bat 会自动带起）。"
