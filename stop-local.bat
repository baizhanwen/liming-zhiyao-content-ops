@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local.ps1"
set "STOP_EXIT=%ERRORLEVEL%"
echo.
if "%STOP_EXIT%"=="0" (
  echo [Liming Zhiyao] Stop check completed.
) else (
  echo [ERROR] The local web app could not be stopped safely.
)
pause
exit /b %STOP_EXIT%
