@echo off
setlocal
cd /d "%~dp0"

if not exist "services\analyzer\.venv\Scripts\python.exe" (
  echo [Liming Zhiyao] The analyzer is not installed. Run setup-analyzer.bat first.
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  echo [ERROR] .dev.vars is missing. Run setup-local.bat first.
  pause
  exit /b 1
)

echo [Liming Zhiyao] Starting the video analyzer. Keep the web app running as well.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-analyzer.ps1"
if errorlevel 1 pause
