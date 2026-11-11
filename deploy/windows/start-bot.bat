@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  QQ bot one-click starter.
rem  ASCII-only on purpose: Chinese in .bat becomes mojibake
rem  under GBK consoles and breaks parsing.
rem
rem  What it does:
rem   1) SnowLuma  - an elevated health watchdog checks the real
rem      QQ API and restarts SnowLuma if its HTTP server stalls.
rem   2) dsh web   - the model backend (auto)
rem   3) model-pool- multi-key proxy (auto)
rem   4) bridge    - the bot + crash-restart watchdog (auto)
rem ============================================================

set "ROOT=D:\deepseek"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Dry run: START_BOT_DRYRUN=1 or "start-bot.bat --dry-run".
rem Prints every launch command without starting anything.
if /i "%~1"=="--dry-run" set "START_BOT_DRYRUN=1"

rem ---- Node resolution + capability probe ----
rem Order: %NODE_EXE% override -> system Node -> "where node" ->
rem bundled SnowLuma runtime. The bundled one is Node 22 and rejects
rem --use-env-proxy, so the flag is always probed, never assumed.
set "NODE_PROXY_FLAG="
set "NODE_PROBE_ERROR="
set "NODE_VERSION="
set "NODE_SOURCE="

if defined NODE_EXE (
  if exist "%NODE_EXE%" (
    set "NODE=%NODE_EXE%"
    set "NODE_SOURCE=NODE_EXE"
  )
)
if not defined NODE_SOURCE (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE=C:\Program Files\nodejs\node.exe"
    set "NODE_SOURCE=system"
  )
)
if not defined NODE_SOURCE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_SOURCE (
      set "NODE=%%i"
      set "NODE_SOURCE=where"
    )
  )
)
if not defined NODE_SOURCE (
  if exist "%ROOT%\snowluma\app\node.exe" (
    set "NODE=%ROOT%\snowluma\app\node.exe"
    set "NODE_SOURCE=snowluma-fallback"
  )
)

if not defined NODE (
  echo [node] ERROR: no node.exe found. Image library will be skipped.
) else (
  "%NODE%" --use-env-proxy -v >"%TEMP%\start-bot-node-probe.txt" 2>&1
  if not errorlevel 1 (
    set "NODE_PROXY_FLAG=--use-env-proxy"
    set /p NODE_VERSION=<"%TEMP%\start-bot-node-probe.txt"
  ) else (
    set /p NODE_PROBE_ERROR=<"%TEMP%\start-bot-node-probe.txt"
    if not defined NODE_PROBE_ERROR set "NODE_PROBE_ERROR=probe exited with a non-zero code"
    "%NODE%" -v >"%TEMP%\start-bot-node-probe.txt" 2>&1
    if not errorlevel 1 set /p NODE_VERSION=<"%TEMP%\start-bot-node-probe.txt"
  )
  del "%TEMP%\start-bot-node-probe.txt" >nul 2>&1
  if not defined NODE_VERSION set "NODE_VERSION=unknown"
  echo [node] path    : !NODE! [source: !NODE_SOURCE!]
  echo [node] version : !NODE_VERSION!
  if defined NODE_PROXY_FLAG (
    echo [node] proxy   : enabled  --use-env-proxy
  ) else (
    echo [node] proxy   : disabled
  )
)
if defined NODE_PROBE_ERROR echo [node] warning : --use-env-proxy rejected, dropping the flag: %NODE_PROBE_ERROR%
if defined START_BOT_DRYRUN echo [dry-run] HOME=%ROOT%  LOGDIR=%LOGDIR%

echo.
echo  ============================================
echo   QQ bot starter
echo  ============================================
echo.

if not defined START_BOT_DRYRUN echo [%date% %time%] ==== one-click begin ==== >> "%LOGDIR%\autostart.log"

rem ---- 1. SnowLuma watchdog (needs admin) ----
echo [1/5] SnowLuma (QQ side)
powershell.exe -NoProfile -Command "if ((Test-Path '%ROOT%\state\snowluma-watchdog-heartbeat.txt') -and ((Get-Date) - (Get-Item '%ROOT%\state\snowluma-watchdog-heartbeat.txt').LastWriteTime).TotalSeconds -lt 45) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo       health watchdog already running
  if not defined START_BOT_DRYRUN echo [%date% %time%] SnowLuma watchdog already up >> "%LOGDIR%\autostart.log"
  if defined START_BOT_DRYRUN echo [dry-run] would skip: start "SnowLumaWatchdogADMIN" powershell.exe -NoProfile -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%ROOT%\repo\deploy\windows\snowluma-watchdog.ps1\"' -Verb RunAs -WindowStyle Hidden"
) else (
  echo       starting elevated health watchdog...
  if not defined START_BOT_DRYRUN echo [%date% %time%] launching elevated SnowLuma watchdog >> "%LOGDIR%\autostart.log"
  if defined START_BOT_DRYRUN (
    echo [dry-run] would run : start "SnowLumaWatchdogADMIN" powershell.exe -NoProfile -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%ROOT%\repo\deploy\windows\snowluma-watchdog.ps1\"' -Verb RunAs -WindowStyle Hidden"
    echo       cwd=%ROOT%  wait=12s
  ) else (
    start "SnowLumaWatchdogADMIN" powershell.exe -NoProfile -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%ROOT%\repo\deploy\windows\snowluma-watchdog.ps1\"' -Verb RunAs -WindowStyle Hidden"
    echo       waiting 12s for it to come up...
    timeout /t 12 /nobreak >nul
  )
)

rem ---- 2. model pool proxy ----
echo [2/5] Model proxy (multi-key)
netstat -ano | findstr /R /C:":18901 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       already running, skip
  if defined START_BOT_DRYRUN echo [dry-run] would skip: start "ModelPool" /MIN /D "%ROOT%" "%ROOT%\model-pool-proxy.bat"
) else (
  echo       starting...
  if defined START_BOT_DRYRUN (
    echo [dry-run] would run : start "ModelPool" /MIN /D "%ROOT%" "%ROOT%\model-pool-proxy.bat"
  ) else (
    start "ModelPool" /MIN /D "%ROOT%" "%ROOT%\model-pool-proxy.bat"
    timeout /t 2 /nobreak >nul
  )
)

rem ---- 2b. editable conversation model router ----
rem The editable conversation model policy runs on its own local proxy.
netstat -ano | findstr /R /C:":18903 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo       starting conversation model router...
  if defined START_BOT_DRYRUN (
    echo [dry-run] would run : start "ModelRouter" /MIN /D "%ROOT%" "%ROOT%\repo\deploy\windows\model-router.bat"
  ) else (
    start "ModelRouter" /MIN /D "%ROOT%" "%ROOT%\repo\deploy\windows\model-router.bat"
    timeout /t 2 /nobreak >nul
  )
) else (
  if defined START_BOT_DRYRUN echo [dry-run] would skip: start "ModelRouter" /MIN /D "%ROOT%" "%ROOT%\repo\deploy\windows\model-router.bat"
)

rem ---- 3. dsh web + persistent watchdog ----
echo [3/5] DSH backend
echo       ensuring watchdog is running...
if defined START_BOT_DRYRUN (
  echo [dry-run] would run : start "DSHWatchdog" /MIN /D "%ROOT%" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\repo\deploy\windows\dsh-watchdog.ps1"
) else (
  start "DSHWatchdog" /MIN /D "%ROOT%" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\repo\deploy\windows\dsh-watchdog.ps1"
)
netstat -ano | findstr /R /C:":3090 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo       waiting 15s for token...
  if not defined START_BOT_DRYRUN timeout /t 15 /nobreak >nul
)

rem ---- 4. bridge + watchdog ----
echo [4/5] Bridge
tasklist /FI "WINDOWTITLE eq QQBridge*" 2>nul | find /I "cmd.exe" >nul 2>&1
if not errorlevel 1 (
  echo       bridge watchdog already running, skip
  if defined START_BOT_DRYRUN echo [dry-run] would skip: start "QQBridge" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\bridge-watchdog.bat"
) else (
  echo       starting bridge watchdog...
  if defined START_BOT_DRYRUN (
    echo [dry-run] would run : start "QQBridge" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\bridge-watchdog.bat"
  ) else (
    start "QQBridge" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\bridge-watchdog.bat"
    timeout /t 3 /nobreak >nul
  )
)

rem ---- 4b. AstrBot plugin sidecar ----
if exist "%ROOT%\state\astrbot-sidecar\AstrBot\data\cmd_config.json" (
  netstat -ano | findstr /R /C:"127.0.0.1:6199 .*LISTENING" >nul 2>&1
  if errorlevel 1 (
    if defined START_BOT_DRYRUN (
      echo [dry-run] would run : start "QQAstrBot" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\astrbot-sidecar-watchdog.bat"
    ) else (
      start "QQAstrBot" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\astrbot-sidecar-watchdog.bat"
    )
  )
)

rem ---- 5. local image library ----
echo [5/5] Image library
if not defined NODE (
  echo       skipped: no usable node.exe found
  if defined START_BOT_DRYRUN echo [dry-run] would skip: ImageLibrary [no node.exe]
) else (
  netstat -ano | findstr /R /C:":18902 .*LISTENING" >nul 2>&1
  if not errorlevel 1 (
    echo       already running, skip
    if defined START_BOT_DRYRUN echo [dry-run] would skip: start "ImageLibrary" /MIN /D "%ROOT%" "!NODE!" !NODE_PROXY_FLAG! "%ROOT%\repo\bridge\src\image-library-server.mjs"
  ) else (
    echo       starting local image library...
    if defined START_BOT_DRYRUN (
      echo [dry-run] would run : start "ImageLibrary" /MIN /D "%ROOT%" "!NODE!" !NODE_PROXY_FLAG! "%ROOT%\repo\bridge\src\image-library-server.mjs"
    ) else (
      start "ImageLibrary" /MIN /D "%ROOT%" "!NODE!" !NODE_PROXY_FLAG! "%ROOT%\repo\bridge\src\image-library-server.mjs"
      timeout /t 2 /nobreak >nul
    )
  )
)

echo.
if not defined START_BOT_DRYRUN echo [%date% %time%] ==== one-click end ==== >> "%LOGDIR%\autostart.log"
if defined START_BOT_DRYRUN echo [dry-run] nothing was started; exiting with 0
echo  ============================================
echo   Done. Check status:
echo     SnowLuma  : http://127.0.0.1:5099
echo     OneBot    : 3002 (2427256325) / 3010 (1668389572)
echo     Keys admin: http://127.0.0.1:18901
echo     Image lib : http://127.0.0.1:18902
echo  ============================================
echo.
echo  If the bot stays silent:
echo    - make sure you logged in to QQ after the ADMIN window opened
echo    - SnowLuma must show the QQ process as injected
echo.
if not defined START_BOT_DRYRUN pause
endlocal
exit /b 0
