@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  QQ bot one-click starter.
rem  ASCII-only on purpose: Chinese in .bat becomes mojibake
rem  under GBK consoles and breaks parsing.
rem
rem  What it does:
rem   1) SnowLuma  - needs ADMIN. This script cannot elevate
rem      itself reliably for injection, so it OPENS an elevated
rem      window and asks you to press Enter there.
rem   2) dsh web   - the model backend (auto)
rem   3) model-pool- multi-key proxy (auto)
rem   4) bridge    - the bot + crash-restart watchdog (auto)
rem ============================================================

set "ROOT=D:\deepseek"
set "NODE=%ROOT%\snowluma\app\node.exe"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo.
echo  ============================================
echo   QQ bot starter
echo  ============================================
echo.

echo [%date% %time%] ==== one-click begin ==== >> "%LOGDIR%\autostart.log"

rem ---- 1. SnowLuma (needs admin) ----
echo [1/5] SnowLuma (QQ side)
netstat -ano | findstr /R /C:":5099 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       already running, skip
  echo [%date% %time%] SnowLuma already up >> "%LOGDIR%\autostart.log"
) else (
  netstat -ano | findstr /R /C:":5100 .*LISTENING" >nul 2>&1
  if not errorlevel 1 (
    echo       running on 5100, skip
    echo [%date% %time%] SnowLuma up on 5100 >> "%LOGDIR%\autostart.log"
  ) else (
    echo       NOT running - opening an elevated window...
    echo       In that new window: press any key, then log in to QQ.
    echo [%date% %time%] launching elevated SnowLuma >> "%LOGDIR%\autostart.log"
    rem NOTE: no parentheses in the window title - cmd chokes on them.
    start "SnowLumaADMIN" powershell.exe -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','\"%ROOT%\snowluma\app\start-admin.bat\"' -Verb RunAs"
    echo       waiting 12s for it to come up...
    timeout /t 12 /nobreak >nul
  )
)

rem ---- 2. model pool proxy ----
echo [2/5] Model proxy (multi-key)
netstat -ano | findstr /R /C:":18901 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       already running, skip
) else (
  echo       starting...
  start "ModelPool" /MIN /D "%ROOT%" "%ROOT%\model-pool-proxy.bat"
  timeout /t 2 /nobreak >nul
)

rem ---- 3. dsh web ----
echo [3/5] DSH backend
netstat -ano | findstr /R /C:":3090 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       already running, skip
) else (
  echo       starting...
  start "DSHWeb" /MIN /D "%ROOT%" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\dsh-run.ps1"
  echo       waiting 15s for token...
  timeout /t 15 /nobreak >nul
)

rem ---- 4. bridge + watchdog ----
echo [4/5] Bridge
tasklist /FI "WINDOWTITLE eq QQBridge*" 2>nul | find /I "cmd.exe" >nul 2>&1
if not errorlevel 1 (
  echo       bridge watchdog already running, skip
) else (
  echo       starting bridge watchdog...
  start "QQBridge" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\bridge-watchdog.bat"
  timeout /t 3 /nobreak >nul
)

rem ---- 5. local image library ----
echo [5/5] Image library
netstat -ano | findstr /R /C:":18902 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo       already running, skip
) else (
  echo       starting local image library...
  start "ImageLibrary" /MIN /D "%ROOT%" "%NODE%" "%ROOT%\repo\bridge\src\image-library-server.mjs"
  timeout /t 2 /nobreak >nul
)

echo.
echo [%date% %time%] ==== one-click end ==== >> "%LOGDIR%\autostart.log"
echo  ============================================
echo   Done. Check status:
echo     SnowLuma  : http://127.0.0.1:5099
echo     Keys admin: http://127.0.0.1:18901
echo     Image lib : http://127.0.0.1:18902
echo  ============================================
echo.
echo  If the bot stays silent:
echo    - make sure you logged in to QQ after the ADMIN window opened
echo    - SnowLuma must show the QQ process as injected
echo.
pause
endlocal
exit /b 0
