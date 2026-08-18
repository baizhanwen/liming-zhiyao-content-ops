@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

echo [Liming Zhiyao] Repairing only the PaddleOCR model cache...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\repair-analyzer-models.ps1" -Component ocr
if errorlevel 1 (
  echo [ERROR] OCR model cache repair failed. Review the message above.
  pause
  exit /b 1
)
pause
exit /b 0
