@echo off
setlocal
if not exist "%~dp0program\stop-local.bat" (
  echo [ERROR] The program folder is missing. Keep it beside this launcher.
  pause
  exit /b 1
)
cd /d "%~dp0program"
call "%~dp0program\stop-local.bat" %*
exit /b %ERRORLEVEL%
