@echo off
setlocal
cd /d "%~dp0"

echo [Liming Zhiyao] Refreshing the local Douyin cookie snapshot...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\refresh-douyin-cookies.ps1"
if errorlevel 1 (
  echo [ERROR] Cookie refresh failed. Review the message above.
  pause
  exit /b 1
)

echo [OK] Cookie refresh completed.
pause
