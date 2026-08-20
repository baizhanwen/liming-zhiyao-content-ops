@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\factory-reset.ps1"
if errorlevel 1 (
  echo [ERROR] Factory reset did not complete.
  pause
  exit /b 1
)
pause
