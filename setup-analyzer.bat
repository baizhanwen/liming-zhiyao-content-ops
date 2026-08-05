@echo off
setlocal
cd /d "%~dp0"

py -3.11 --version >nul 2>nul || goto :missing_python
where ffmpeg >nul 2>nul || echo [NOTICE] FFmpeg was not found. Add ffmpeg and ffprobe to PATH before analysis.
where ffprobe >nul 2>nul || echo [NOTICE] ffprobe was not found. It is normally included with FFmpeg.

if not exist ".dev.vars" copy /Y ".dev.vars.example" ".dev.vars" >nul
if not exist "services\analyzer\.venv\Scripts\python.exe" (
  echo [Liming Zhiyao] Creating the Python 3.11 environment...
  py -3.11 -m venv "services\analyzer\.venv"
  if errorlevel 1 goto :failed
)

echo [Liming Zhiyao] Installing video analysis dependencies. The first install can take a while...
"services\analyzer\.venv\Scripts\python.exe" -m pip install -e "services\analyzer[media]"
if errorlevel 1 goto :failed

echo [Liming Zhiyao] Analyzer setup completed. Add model credentials to .dev.vars, then run start-analyzer.bat.
pause
exit /b 0

:missing_python
echo [ERROR] Python 3.11 was not found. Install 64-bit Python 3.11 with the py launcher.
pause
exit /b 1

:failed
echo [ERROR] Analyzer setup failed. Review the error shown above.
pause
exit /b 1
