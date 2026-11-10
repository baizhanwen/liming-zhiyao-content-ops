@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="--check-runtime" goto :guard_ready
if /i "%~1"=="--guarded" goto :guard_ready
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-web-guard.ps1" -Entry setup-local
exit /b %errorlevel%

:guard_ready

echo [Liming Zhiyao] Checking the local runtime...
call :find_node
if /i "%~1"=="--check-runtime" goto :check_runtime
if defined NODE_EXE goto :node_ready

echo [NOTICE] 64-bit Node.js 22.13 or newer was not found.
echo [ACTION] Downloading and installing the official signed Node.js runtime...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node22.ps1" -NodePathFile "%~dp0.local\node.path"
if errorlevel 1 goto :node_install_failed
call :find_node
if not defined NODE_EXE goto :node_install_failed

:node_ready
set "PATH=%NODE_HOME%;%PATH%"
echo [OK] Using %NODE_EXE%

if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [Liming Zhiyao] Created the local runtime configuration.
) else (
  echo [Liming Zhiyao] Keeping the existing .dev.vars file.
)

echo [Liming Zhiyao] Installing web dependencies...
call "%NPM_CMD%" ci
if errorlevel 1 goto :failed
if not exist "node_modules\wrangler\bin\wrangler.js" goto :dependencies_incomplete
if not exist "node_modules\vinext\package.json" goto :dependencies_incomplete
echo [OK] Web dependencies passed completeness verification.

echo [Liming Zhiyao] Initializing the local database...
set "CI=1"
call "%NPM_CMD%" run db:local:migrate
set "CI="
if errorlevel 1 goto :failed

echo [Liming Zhiyao] Synchronizing authorized content knowledge...
call "%NPM_CMD%" run knowledge:local:sync
if errorlevel 1 goto :failed

echo.
echo [Liming Zhiyao] Web setup completed.
echo Run start-local.bat, create your administrator account, then configure models and video analysis in Settings.
pause
exit /b 0

:check_runtime
if not defined NODE_EXE (
  echo [ERROR] 64-bit Node.js 22.13 or newer with npm was not found.
  exit /b 1
)
echo [OK] Node.js runtime: %NODE_EXE%
"%NODE_EXE%" --version
call "%NPM_CMD%" --version
exit /b 0

:node_install_failed
echo.
echo [ERROR] Node.js 22 could not be installed or verified automatically.
echo Check the internet connection and Windows approval prompt, then run this file again.
pause
exit /b 1

:failed
echo.
echo [ERROR] Setup did not complete. Review the error shown above.
pause
exit /b 1

:dependencies_incomplete
echo.
echo [ERROR] npm finished, but required web dependency files are still missing.
echo Check Windows Security quarantine and folder permissions, then run setup-local.bat again.
pause
exit /b 1

:find_node
set "NODE_EXE="
set "NODE_HOME="
set "NPM_CMD="
if exist "%~dp0.local\node.path" set /p NODE_HOME=<"%~dp0.local\node.path"
if defined NODE_HOME call :try_node "%NODE_HOME%\node.exe"
if not defined NODE_EXE call :try_node "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE call :try_node "%LocalAppData%\Programs\nodejs\node.exe"
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE call :try_node "%%N"
exit /b 0

:try_node
if defined NODE_EXE exit /b 0
if not exist "%~1" exit /b 0
if not exist "%~dp1npm.cmd" exit /b 0
"%~1" -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(process.arch === 'x64' && (major > 22 || (major === 22 && minor >= 13)) ? 0 : 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "NODE_EXE=%~1"
set "NODE_HOME=%~dp1"
set "NPM_CMD=%~dp1npm.cmd"
exit /b 0
