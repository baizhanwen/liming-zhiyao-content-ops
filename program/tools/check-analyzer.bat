@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"
title Liming Zhiyao - Analyzer Diagnostic
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\check-analyzer.ps1"
echo.
pause
