@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="--guarded" goto :guard_ready
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-web-guard.ps1" -Entry start-local
exit /b %errorlevel%

:guard_ready

rem run-web-guard.ps1 selects and validates Node and npm using the shared selector.
if not defined LMZY_NODE_HOME (
  echo [ERROR] No compatible Node.js and npm were selected. Run setup-local.bat.
  pause
  exit /b 1
)
set "NODE_EXE=%LMZY_NODE_HOME%\node.exe"
set "NPM_CLI=%LMZY_NODE_HOME%\node_modules\npm\bin\npm-cli.js"
set "PATH=%LMZY_NODE_HOME%;%PATH%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-local-web.ps1" -CheckDependenciesOnly
if errorlevel 1 (
  pause
  exit /b 1
)

set "LOCAL_APP_PORT="
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\select-local-port.ps1"`) do set "LOCAL_APP_PORT=%%P"
if not defined LOCAL_APP_PORT (
  echo [ERROR] No usable local port was found.
  pause
  exit /b 1
)
set "LOCAL_APP_URL=http://127.0.0.1:%LOCAL_APP_PORT%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-web-identity.ps1" -CheckHealth -HealthPort %LOCAL_APP_PORT% >nul 2>nul
if not errorlevel 1 (
  echo [Liming Zhiyao] The app is already running at %LOCAL_APP_URL%
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-analyzer-background.ps1" -BaseUrl "%LOCAL_APP_URL%"
  if errorlevel 1 echo [NOTICE] The web app is available, but the video analyzer needs attention. Run tools\setup-analyzer.bat if it is not installed.
  start "" "%LOCAL_APP_URL%"
  exit /b 0
)

netstat -ano | findstr ":%LOCAL_APP_PORT%" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [ERROR] Port %LOCAL_APP_PORT% is occupied by an unhealthy process.
  echo Close the old app process, then run start-local.bat again.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-local-web.ps1"
if errorlevel 1 (
  echo [ERROR] Web initialization failed. Review the error shown above.
  pause
  exit /b 1
)

set "ANALYZER_BASE_URL=%LOCAL_APP_URL%"
echo [Liming Zhiyao] Starting %LOCAL_APP_URL%
if not "%LOCAL_APP_PORT%"=="3000" echo [NOTICE] This installation uses port %LOCAL_APP_PORT%. Always use the address shown above.
echo The browser and video analyzer will start automatically when ready.
echo Press Ctrl+C or run stop-local.bat to stop everything.
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\open-local.ps1" -Url "%LOCAL_APP_URL%"
"%NODE_EXE%" "%NPM_CLI%" run dev -- --hostname 127.0.0.1 --port %LOCAL_APP_PORT%
if errorlevel 1 (
  echo [ERROR] The web app stopped unexpectedly. Review the error shown above.
  pause
  exit /b 1
)
