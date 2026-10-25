@echo off
setlocal
rem Bridge watchdog: restart the bot 5 seconds after any crash, keeping it online.
set "ROOT=D:\deepseek"
set "NODE=node"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set /a RESTARTS=0

rem Tool API supplies the QQ MCP tools and reconnects independently.
netstat -ano | findstr /R /C:":3100 .*LISTENING" >nul 2>&1
if errorlevel 1 start "QQTools" /MIN /D "%ROOT%\repo\bridge" "%ROOT%\repo\bridge\tool-service-watchdog.bat"

:loop
set /a RESTARTS+=1
echo [%date% %time%] bridge starting attempt %RESTARTS% >> "%LOGDIR%\bridge.log"
"%NODE%" "%ROOT%\repo\bridge\src\qq-bot.mjs" >> "%LOGDIR%\bridge.log" 2>&1
echo [%date% %time%] bridge exited with code %errorlevel%, restarting in 5s >> "%LOGDIR%\bridge.log"
timeout /t 5 /nobreak >nul
goto loop
