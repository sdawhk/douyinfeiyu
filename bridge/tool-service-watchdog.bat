@echo off
setlocal
set "ROOT=D:\deepseek"
set "QQ_TOOL_SIDECAR=1"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
:loop
echo [%date% %time%] tool service starting >> "%ROOT%\logs\qq-tools.log"
node "%ROOT%\repo\bridge\src\bridge.js" >> "%ROOT%\logs\qq-tools.log" 2>&1
echo [%date% %time%] tool service exited with code %errorlevel%, restarting in 5s >> "%ROOT%\logs\qq-tools.log"
timeout /t 5 /nobreak >nul
goto loop
