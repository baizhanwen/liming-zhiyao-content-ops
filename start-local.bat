@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\wrangler\bin\wrangler.js" (
  echo [ERROR] Web dependencies are missing or incomplete. Run setup-local.bat first.
  pause
  exit /b 1
)
if not exist "node_modules\vinext\package.json" (
  echo [ERROR] Web dependencies are missing or incomplete. Run setup-local.bat first.
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [Liming Zhiyao] Created the local .dev.vars configuration.
)

set "LOCAL_APP_PORT="
for /f "usebackq delims=" %%P in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\select-local-port.ps1"`) do set "LOCAL_APP_PORT=%%P"
if not defined LOCAL_APP_PORT (
  echo [ERROR] No usable local port was found.
  pause
  exit /b 1
)
set "LOCAL_APP_URL=http://127.0.0.1:%LOCAL_APP_PORT%"

powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%LOCAL_APP_URL%/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
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

echo [Liming Zhiyao] Checking database migrations...
set "CI=1"
call npm run db:local:migrate
set "CI="
if errorlevel 1 (
  echo [ERROR] Database initialization failed. Review the error shown above.
  pause
  exit /b 1
)

call npm run auth:startup
if errorlevel 1 (
  echo [ERROR] Login session initialization failed.
  pause
  exit /b 1
)

echo [Liming Zhiyao] Checking authorized content knowledge...
call npm run knowledge:local:sync
if errorlevel 1 (
  echo [ERROR] Authorized content knowledge could not be synchronized.
  pause
  exit /b 1
)

set "ANALYZER_BASE_URL=%LOCAL_APP_URL%"
echo [Liming Zhiyao] Starting %LOCAL_APP_URL%
if not "%LOCAL_APP_PORT%"=="3000" echo [NOTICE] Windows reserved port 3000, so this run uses port %LOCAL_APP_PORT%.
echo The browser and video analyzer will start automatically when ready.
echo Press Ctrl+C or run stop-local.bat to stop everything.
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\open-local.ps1" -Url "%LOCAL_APP_URL%"
call npm run dev -- --hostname 127.0.0.1 --port %LOCAL_APP_PORT%
if errorlevel 1 (
  echo [ERROR] The web app stopped unexpectedly. Review the error shown above.
  pause
  exit /b 1
)
