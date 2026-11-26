@echo off
setlocal enabledelayedexpansion
rem QQ <-> DeepSeek Harness bridge: autostart entry.
rem Run by Task Scheduler 1 minute after user logon.
rem
rem NOTE: this task runs WITHOUT highest privileges on purpose.
rem SnowLuma must inject into QQ, which lives in the interactive desktop
rem session; a highest-privileges task runs in isolated session 0 and cannot
rem see or inject into desktop QQ. Starting SnowLuma elevated stays a manual
rem step; everything else here is automatic.
rem
rem Startup order (dependencies):
rem   1) SnowLuma  - QQ protocol side
rem   2) model-pool - multi-key proxy (deepseek-flash -> deepseek-v4.1-flash-free)
rem   3) dsh web   - DSH API; prints a NEW token each start (captured below)
rem   4) bridge    - the bot, with crash-restart watchdog
rem
rem Design notes learned the hard way in this environment:
rem   - ASCII-only: Chinese comments become mojibake under GBK consoles and
rem     break .bat parsing ("'xxx' is not recognized").
rem   - Launched children must be started with `start` and the launching bat
rem     must EXIT promptly, or the child is torn down with the caller.
rem   - DSH output is written with shared read access, so the bridge can read
rem     the fresh token while the DSH process remains running.
rem ASCII-only on purpose.

set "ROOT=D:\deepseek"
rem The bundled SnowLuma node.exe is low-integrity and cannot inject into QQ.
set "NODE=C:\Program Files\nodejs\node.exe"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo [%date% %time%] ==== autostart begin ==== >> "%LOGDIR%\autostart.log"

rem ---- 1. SnowLuma ----
netstat -ano | findstr /R /C:":5099 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] starting SnowLuma >> "%LOGDIR%\autostart.log"
  set "SNOWLUMA_HOOK_AUTOLOAD=1"
  start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-process-launcher.vbs" "%ROOT%\snowluma\app" "%NODE%" "%ROOT%\snowluma\app\index.mjs"
) else (
  echo [%date% %time%] SnowLuma already up, skip >> "%LOGDIR%\autostart.log"
)

rem ---- 2. multi-key model proxy (reads keys.json, auto-rotates on quota failure) ----
netstat -ano | findstr /R /C:":18901 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] starting model-pool >> "%LOGDIR%\autostart.log"
  start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-batch-launcher.vbs" "%ROOT%" "%ROOT%\model-pool-proxy.bat"
) else (
  echo [%date% %time%] model-pool already up, skip >> "%LOGDIR%\autostart.log"
)

rem ---- 2b. editable conversation model router ----
rem Editable conversation model router (separate from the keys admin on 18901).
netstat -ano | findstr /R /C:":18903 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] starting model router >> "%LOGDIR%\autostart.log"
  start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-batch-launcher.vbs" "%ROOT%" "%ROOT%\repo\deploy\windows\model-router.bat"
)

rem ---- 2c. loopback forward proxy on 12450 ----
rem The user-level HTTP_PROXY/HTTPS_PROXY/ALL_PROXY env points at 12450, but
rem the user's proxy client is not always running. dsh installs that env as
rem its process-wide outbound dispatcher, so a dead 12450 breaks every
rem upstream model call. This forwarder occupies 12450 and dials out
rem directly, keeping the model lane alive until the env is cleaned up.
netstat -ano | findstr /R /C:":12450 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] starting 12450 forwarder >> "%LOGDIR%\autostart.log"
  start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-process-launcher.vbs" "%ROOT%\state" "%NODE%" "%ROOT%\state\proxy-forwarder.mjs"
) else (
  echo [%date% %time%] 12450 forwarder already up, skip >> "%LOGDIR%\autostart.log"
)

rem ---- 3. dsh watchdog (token captured to dshweb.out by dsh-run.ps1) ----
echo [%date% %time%] ensuring dsh watchdog >> "%LOGDIR%\autostart.log"
start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\dsh-watchdog-launcher.vbs"

rem ---- 4. bridge watchdog (it waits for dsh, then patches token + runs bot) ----
tasklist /FI "WINDOWTITLE eq QQBridge*" 2>nul | find /I "cmd.exe" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] starting bridge watchdog >> "%LOGDIR%\autostart.log"
  start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-batch-launcher.vbs" "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\bridge-watchdog.bat"
) else (
  echo [%date% %time%] bridge watchdog already up, skip >> "%LOGDIR%\autostart.log"
)

rem ---- 4b. AstrBot plugin sidecar ----
if exist "%ROOT%\state\astrbot-sidecar\AstrBot\data\cmd_config.json" (
  netstat -ano | findstr /R /C:"127.0.0.1:6199 .*LISTENING" >nul 2>&1
  if errorlevel 1 start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-batch-launcher.vbs" "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\astrbot-sidecar-watchdog.bat"
)

rem ---- 5. local image library ----
netstat -ano | findstr /R /C:":18902 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] starting image library >> "%LOGDIR%\autostart.log"
  start "" /B "%SystemRoot%\System32\wscript.exe" //B //NoLogo "%ROOT%\repo\deploy\windows\hidden-process-launcher.vbs" "%ROOT%" "%NODE%" --use-env-proxy "%ROOT%\repo\bridge\src\image-library-server.mjs"
) else (
  echo [%date% %time%] image library already up, skip >> "%LOGDIR%\autostart.log"
)

echo [%date% %time%] ==== autostart end ==== >> "%LOGDIR%\autostart.log"
endlocal
exit /b 0
