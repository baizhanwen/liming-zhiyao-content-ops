@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "services\analyzer\.venv\Scripts\python.exe" (
  echo [利明智耀] 尚未安装分析服务，请先双击 setup-analyzer.bat。
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  echo [错误] 缺少 .dev.vars，请先运行 setup-local.bat。
  pause
  exit /b 1
)

echo [利明智耀] 正在启动视频分析服务。网页端也必须保持运行。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-analyzer.ps1"
if errorlevel 1 pause
