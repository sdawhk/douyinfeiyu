@echo off
setlocal
set "ROOT=D:\deepseek"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

:loop
rem The plugin sidecar owns only the loopback reverse OneBot port.
netstat -ano | findstr /R /C:"127.0.0.1:6199 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  timeout /t 5 /nobreak >nul
  goto loop
)
echo [%date% %time%] AstrBot sidecar starting >> "%LOGDIR%\astrbot-sidecar.log"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\repo\bridge\scripts\start-astrbot-sidecar.ps1" >> "%LOGDIR%\astrbot-sidecar.log" 2>&1
echo [%date% %time%] AstrBot sidecar exited with code %errorlevel%; retrying >> "%LOGDIR%\astrbot-sidecar.log"
timeout /t 5 /nobreak >nul
goto loop
