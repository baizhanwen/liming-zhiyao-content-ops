@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

if not exist "services\analyzer\.venv\Scripts\python.exe" (
  echo [Liming Zhiyao] The analyzer is not installed. Run tools\setup-analyzer.bat first.
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  echo [ERROR] .dev.vars is missing. Run setup-local.bat first.
  pause
  exit /b 1
)
if not exist ".local\app.port" (
  echo [ERROR] The local web app is not running. Run start-local.bat first.
  pause
  exit /b 1
)
set "LOCAL_APP_PORT="
set /p LOCAL_APP_PORT=<".local\app.port"
if not defined LOCAL_APP_PORT (
  echo [ERROR] The saved local app port is empty. Run start-local.bat again.
  pause
  exit /b 1
)

echo [Liming Zhiyao] Starting the video analyzer in the background...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\start-analyzer-background.ps1" -BaseUrl "http://127.0.0.1:%LOCAL_APP_PORT%"
if errorlevel 1 (
  echo [ERROR] The video analyzer could not start. Review .local\analyzer-start-error.txt.
  pause
  exit /b 1
)
echo [OK] The video analyzer is running. Use stop-local.bat to stop it.
pause
