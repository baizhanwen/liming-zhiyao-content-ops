@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo [利明智耀] 正在检查本地运行环境...
where node >nul 2>nul || goto :missing_node
where npm >nul 2>nul || goto :missing_node

for /f %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 22 goto :old_node

if not exist ".dev.vars" (
  copy /Y ".dev.vars.example" ".dev.vars" >nul
  echo [利明智耀] 已创建 .dev.vars，本地身份已启用。
) else (
  echo [利明智耀] 保留现有 .dev.vars，不覆盖任何密钥。
)

echo [利明智耀] 正在安装网页依赖...
call npm ci
if errorlevel 1 goto :failed

echo [利明智耀] 正在初始化本地数据库...
set "CI=1"
call npm run db:local:migrate
set "CI="
if errorlevel 1 goto :failed

echo.
echo [利明智耀] 网页端安装完成。
echo 双击 start-local.bat 即可启动；视频分析服务请另行运行 setup-analyzer.bat。
pause
exit /b 0

:missing_node
echo [错误] 未找到 Node.js/npm。请安装 Node.js 22.13 或更高版本。
pause
exit /b 1

:old_node
echo [错误] 当前 Node.js 主版本为 %NODE_MAJOR%，需要 22.13 或更高版本。
pause
exit /b 1

:failed
echo.
echo [错误] 安装未完成，请保留本窗口中的报错信息。
pause
exit /b 1
