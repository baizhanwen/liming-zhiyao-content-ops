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

echo [Liming Zhiyao] Starting the video analyzer in the background...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-analyzer-background.ps1"
if errorlevel 1 (
  echo [ERROR] The video analyzer could not start. Review .local\analyzer-start-error.txt.
  pause
  exit /b 1
)
echo [OK] The video analyzer is running. Use stop-local.bat to stop it.
pause
