@echo off
setlocal
title Liming Zhiyao - Douyin Cookie Auto Sync
set "SYNC_EXTENSION_DIR=%~dp0douyin-cookie-sync"
if not exist "%SYNC_EXTENSION_DIR%\manifest.json" (
  echo [ERROR] The extension folder is missing.
  pause
  exit /b 1
)
echo Install once in Edge on the analyzer computer:
echo 1. Open edge://extensions and enable Developer mode.
echo 2. Choose Load unpacked, then select the folder below:
echo %SYNC_EXTENSION_DIR%
echo 3. Sign in to Douyin in the same browser profile.
echo 4. Open the local Video Analysis page and select your company.
echo 5. Open the new extension and enable auto sync.
echo.
start "" explorer.exe "%SYNC_EXTENSION_DIR%"
echo See README.md in this folder for Chinese instructions.
pause
