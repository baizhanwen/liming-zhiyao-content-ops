@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
  echo [利明智耀] 尚未安装，请先双击 setup-local.bat。
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [利明智耀] 已创建本地配置 .dev.vars。
)

echo [利明智耀] 正在检查数据库迁移...
set "CI=1"
call npm run db:local:migrate
set "CI="
if errorlevel 1 (
  echo [错误] 数据库初始化失败，请查看上方信息。
  pause
  exit /b 1
)

echo [利明智耀] 正在启动 http://127.0.0.1:3000
echo 浏览器会在服务就绪后自动打开。按 Ctrl+C 可停止。
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\open-local.ps1"
call npm run dev
