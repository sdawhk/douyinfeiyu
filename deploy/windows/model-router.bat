@echo off
setlocal
set "PORT=18903"
cd /d D:\deepseek
"C:\Program Files\nodejs\node.exe" "D:\deepseek\repo\deploy\windows\model-pool-proxy.mjs" >> "D:\deepseek\logs\model-router.log" 2>&1
