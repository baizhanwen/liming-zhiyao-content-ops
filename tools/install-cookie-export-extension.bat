@echo off
setlocal
title Liming Zhiyao - Cookie Export Extension
set "EXTENSION_URL=https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"

echo [Liming Zhiyao] Opening the official Cookie export extension page...
echo.
echo 1. Choose Get or Add to browser on the extension page.
echo 2. Open douyin.com and sign in when the site requires it.
echo 3. Open the extension and keep Export Format set to Netscape.
echo 4. Choose Export for the current Douyin site.
echo 5. In Video Analysis, choose Update Cookie and select cookies.txt.
echo.
echo Security: delete cookies.txt from Downloads after the import succeeds.
echo.

start "" "%EXTENSION_URL%"
if errorlevel 1 (
  echo.
  echo [ERROR] The extension page could not be opened.
  pause
  exit /b 1
)

echo.
echo [OK] The official extension page has been opened in your browser.
pause
exit /b 0
