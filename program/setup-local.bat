@echo off
setlocal
cd /d "%~dp0"

if /i "%~1"=="--check-runtime" goto :check_runtime
if /i "%~1"=="--guarded" goto :guard_ready
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-web-guard.ps1" -Entry setup-local
exit /b %errorlevel%

:guard_ready
echo [Liming Zhiyao] Checking the local runtime...
if defined LMZY_RUNTIME_RETRY goto :node_ready
echo [ACTION] Selecting or preparing a compatible Node.js runtime for this project...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node22.ps1" -NodePathFile "%~dp0.local\node.path"
if errorlevel 1 goto :node_install_failed
rem The installer saves the selected existing or portable runtime as UTF-8.
rem The original guard owns startup while its child restores the Unicode PATH.
set "LMZY_RUNTIME_RETRY=1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-web-guard.ps1" -Entry setup-local -InheritedGuard
exit /b %errorlevel%

:node_ready
if not defined LMZY_NODE_HOME goto :node_install_failed
set "NODE_HOME=%LMZY_NODE_HOME%"
set "NODE_EXE=%LMZY_NODE_HOME%\node.exe"
set "NPM_CLI=%LMZY_NODE_HOME%\node_modules\npm\bin\npm-cli.js"
set "PATH=%NODE_HOME%;%PATH%"
echo [OK] Using %NODE_EXE%

if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [Liming Zhiyao] Created the local runtime configuration.
) else (
  echo [Liming Zhiyao] Keeping the existing .dev.vars file.
)

echo [Liming Zhiyao] Installing web dependencies...
"%NODE_EXE%" "%NPM_CLI%" ci
if errorlevel 1 goto :failed
if not exist "node_modules\wrangler\bin\wrangler.js" goto :dependencies_incomplete
if not exist "node_modules\vinext\package.json" goto :dependencies_incomplete
echo [OK] Web dependencies passed completeness verification.

echo [Liming Zhiyao] Initializing the local database...
set "CI=1"
"%NODE_EXE%" "%NPM_CLI%" run db:local:migrate
set "CI="
if errorlevel 1 goto :failed

echo [Liming Zhiyao] Synchronizing authorized content knowledge...
"%NODE_EXE%" "%NPM_CLI%" run knowledge:local:sync
if errorlevel 1 goto :failed

echo.
echo [Liming Zhiyao] Web setup completed.
echo Run start-local.bat, create your administrator account, then configure models and video analysis in Settings.
pause
exit /b 0

:check_runtime
rem Read-only shared selection uses PowerShell UTF-8, never CMD set /p.
set "LMZY_SETUP_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$root=$env:LMZY_SETUP_ROOT; . (Join-Path $root 'scripts\install-node22.ps1'); $node=Find-NodeRuntime -PathFile (Join-Path $root '.local\node.path'); if (-not $node) { Write-Host '[ERROR] No compatible Windows x64 Node.js and npm were found. Run setup-local.bat.'; exit 1 }; & $node --version; if ($LASTEXITCODE -ne 0) { exit 1 }; $npmCli=Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'; & $node $npmCli --version; exit $LASTEXITCODE"
exit /b %errorlevel%

:node_install_failed
echo.
echo [ERROR] The project Node.js runtime could not be prepared or verified automatically.
echo Check the network and project folder permissions, then run this file again.
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
