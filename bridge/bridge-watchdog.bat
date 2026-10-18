@echo off
setlocal
rem Bridge watchdog: restart the bot 5 seconds after any crash, keeping it online.
set "ROOT=D:\deepseek"
set "NODE=%ROOT%\snowluma\app\node.exe"
set "LOGDIR=%ROOT%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

:loop
echo [%date% %time%] bridge starting >> "%LOGDIR%\bridge.log"
"%NODE%" "%ROOT%\repo\bridge\src\qq-bot.mjs" >> "%LOGDIR%\bridge.log" 2>&1
echo [%date% %time%] bridge exited, restarting in 5s >> "%LOGDIR%\bridge.log"
timeout /t 5 /nobreak >nul
goto loop
