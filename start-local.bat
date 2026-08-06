@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [Liming Zhiyao] Dependencies are missing. Run setup-local.bat first.
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [Liming Zhiyao] Created the local .dev.vars configuration.
)

powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo [Liming Zhiyao] The app is already running at http://127.0.0.1:3000
  start "" "http://127.0.0.1:3000"
  exit /b 0
)

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [ERROR] Port 3000 is occupied by an unhealthy process.
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

echo [Liming Zhiyao] Starting http://127.0.0.1:3000
echo The browser and video analyzer will start automatically when ready.
echo Press Ctrl+C or run stop-local.bat to stop everything.
start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\open-local.ps1"
call npm run dev
if errorlevel 1 (
  echo [ERROR] The web app stopped unexpectedly. Review the error shown above.
  pause
  exit /b 1
)
