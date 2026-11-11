@echo off
setlocal
cd /d "%~dp0"
if not "%~1"=="" (
  echo [ERROR] Usage: prepare-delivery.bat
  echo Only the complete development edition is supported.
  exit /b 2
)
echo [Liming Zhiyao] Preparing the complete development edition with the method library.
echo No customer name, package tier, or activation code is required.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-delivery.ps1" -Distribution github
if errorlevel 1 (
  echo [ERROR] Delivery package was not created.
  pause
  exit /b 1
)
pause
exit /b 0
