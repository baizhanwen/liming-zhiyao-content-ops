@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

echo [Liming Zhiyao] Importing a Douyin cookie snapshot exported from Edge...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\refresh-douyin-cookies.ps1"
if errorlevel 1 (
  echo [ERROR] Cookie refresh failed. Review the message above.
  pause
  exit /b 1
)

echo [OK] Cookie refresh completed.
pause
