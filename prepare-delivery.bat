@echo off
setlocal
cd /d "%~dp0"
set "CUSTOMER_NAME="
set /p "CUSTOMER_NAME=Customer company name: "
if not defined CUSTOMER_NAME (
  echo [ERROR] Customer name is required.
  pause
  exit /b 1
)
echo.
echo Select the commercial package to deliver:
echo   1. Basic Collaboration - no video analysis, WeChat image, or insights modules
echo   2. Intelligent Production - video analysis and WeChat image modules
echo   3. Full Operations - all modules
set "PLAN_CHOICE="
set /p "PLAN_CHOICE=Plan [1/2/3, default 2]: "
if not defined PLAN_CHOICE set "PLAN_CHOICE=2"
if "%PLAN_CHOICE%"=="1" set "PLAN_CODE=starter"
if "%PLAN_CHOICE%"=="2" set "PLAN_CODE=team"
if "%PLAN_CHOICE%"=="3" set "PLAN_CODE=scale"
if not defined PLAN_CODE (
  echo [ERROR] Plan must be 1, 2, or 3.
  pause
  exit /b 1
)
echo.
echo Include the built-in Liming Zhiyao authorized method library?
echo   Y. Include 4,176 licensed method atoms in this delivery
echo   N. Deliver an empty method library; the customer can import a package later
set "METHOD_LIBRARY_CHOICE="
set /p "METHOD_LIBRARY_CHOICE=Authorized method library [Y/N, default Y]: "
if not defined METHOD_LIBRARY_CHOICE set "METHOD_LIBRARY_CHOICE=Y"
if /i "%METHOD_LIBRARY_CHOICE%"=="Y" set "METHOD_LIBRARY_MODE=include"
if /i "%METHOD_LIBRARY_CHOICE%"=="N" set "METHOD_LIBRARY_MODE=exclude"
if not defined METHOD_LIBRARY_MODE (
  echo [ERROR] Authorized method library must be Y or N.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-delivery.ps1" -CustomerName "%CUSTOMER_NAME%" -PlanCode "%PLAN_CODE%" -AuthorizedKnowledge "%METHOD_LIBRARY_MODE%"
if errorlevel 1 (
  echo [ERROR] Delivery package was not created.
  pause
  exit /b 1
)
pause
