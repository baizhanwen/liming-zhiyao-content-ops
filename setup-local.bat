@echo off
setlocal
cd /d "%~dp0"

echo [Liming Zhiyao] Checking the local runtime...
where node >nul 2>nul || goto :missing_node
where npm >nul 2>nul || goto :missing_node

for /f %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 22 goto :old_node

if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [Liming Zhiyao] Created .dev.vars with local identity enabled.
) else (
  echo [Liming Zhiyao] Keeping the existing .dev.vars file.
)

echo [Liming Zhiyao] Installing web dependencies...
call npm ci
if errorlevel 1 goto :failed

echo [Liming Zhiyao] Initializing the local database...
set "CI=1"
call npm run db:local:migrate
set "CI="
if errorlevel 1 goto :failed

echo.
echo [Liming Zhiyao] Web setup completed.
echo Run start-local.bat to start the app. Video analysis is installed separately with setup-analyzer.bat.
pause
exit /b 0

:missing_node
echo [ERROR] Node.js or npm was not found. Install Node.js 22.13 or newer.
pause
exit /b 1

:old_node
echo [ERROR] Node.js major version %NODE_MAJOR% is too old. Version 22.13 or newer is required.
pause
exit /b 1

:failed
echo.
echo [ERROR] Setup did not complete. Review the error shown above.
pause
exit /b 1
