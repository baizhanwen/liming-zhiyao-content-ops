@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
if not exist "%~dp0diagnose_whisper_gpu.py" goto :package_incomplete
if not exist "%~dp0gpu_diagnostics.py" goto :package_incomplete
if not exist "%~dp0asr-check-zh.wav" goto :package_incomplete
set "PROBE_PROGRAM=%~1"
if not defined PROBE_PROGRAM if exist "%~dp0..\services\analyzer\.venv\Scripts\python.exe" set "PROBE_PROGRAM=%~dp0.."
if not defined PROBE_PROGRAM set /p "PROBE_PROGRAM=Enter the installed project folder (or its program folder): "
if not defined PROBE_PROGRAM goto :program_missing
set "PROBE_PROGRAM=%PROBE_PROGRAM:"=%"
if not defined PROBE_PROGRAM goto :program_missing
if exist "%PROBE_PROGRAM%\program\scripts\analyzer_local_runtime.py" set "PROBE_PROGRAM=%PROBE_PROGRAM%\program"
if not exist "%PROBE_PROGRAM%\scripts\analyzer_local_runtime.py" goto :program_missing
if not exist "%PROBE_PROGRAM%\services\analyzer\.venv\Scripts\python.exe" (
  echo Analyzer Python was not found. No packages or files have been changed.
  pause
  exit /b 1
)
set "PYTHONDONTWRITEBYTECODE=1"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PROBE_SAMPLE=%~dp0asr-check-zh.wav"
:choose_output
set "PROBE_OUTPUT=%~dp0whisper-gpu-result-%RANDOM%-%RANDOM%.json"
if exist "%PROBE_OUTPUT%" goto :choose_output
rem The final dot prevents a trailing folder backslash from escaping Python's closing argument quote.
"%PROBE_PROGRAM%\services\analyzer\.venv\Scripts\python.exe" "%~dp0diagnose_whisper_gpu.py" --program "%PROBE_PROGRAM%\." --sample "%PROBE_SAMPLE%" --output "%PROBE_OUTPUT%"
set "PROBE_RESULT=%ERRORLEVEL%"
if not exist "%PROBE_OUTPUT%" goto :report_unavailable
"%PROBE_PROGRAM%\services\analyzer\.venv\Scripts\python.exe" -c "import json,sys; report=json.load(open(sys.argv[1], encoding='utf-8')); sys.exit(0 if isinstance(report, dict) and isinstance(report.get('probe'), dict) else 1)" "%PROBE_OUTPUT%"
if errorlevel 1 goto :report_unavailable
echo.
echo Diagnostic report created:
echo "%PROBE_OUTPUT%"
echo Send this newly generated JSON. Older result files belong to earlier runs.
echo Diagnostic exit code: %PROBE_RESULT%
if not "%PROBE_RESULT%"=="0" echo The GPU probe failed or could not run; read this JSON for details.
pause
exit /b %PROBE_RESULT%

:package_incomplete
echo.
echo Diagnostic package files are missing from this folder.
echo Fully extract the ZIP to a writable folder before running this CMD.
echo Keep diagnose_whisper_gpu.py, gpu_diagnostics.py and asr-check-zh.wav beside this CMD.
echo Do not run the CMD directly inside a ZIP or copy only the CMD out of it.
echo No diagnostic was started. No packages or business files have been changed.
pause
exit /b 1

:program_missing
echo.
echo The installed project folder was not found or is incomplete.
echo Enter the folder containing scripts\analyzer_local_runtime.py and services\analyzer.
echo No diagnostic was started. No packages or business files have been changed.
pause
exit /b 1

:report_unavailable
if "%PROBE_RESULT%"=="0" set "PROBE_RESULT=1"
echo.
echo Diagnostic failed to create a usable report for this run.
echo Do not send an older result JSON as this run's result.
echo Send the error text from this window. Check the extracted files and project path, then retry.
echo Expected report: "%PROBE_OUTPUT%"
echo Exit code: %PROBE_RESULT%
pause
exit /b %PROBE_RESULT%
