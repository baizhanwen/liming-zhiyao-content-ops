@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

py -3.11 --version >nul 2>nul || goto :missing_python
where ffmpeg >nul 2>nul || echo [提醒] 未找到 FFmpeg。安装后请确认 ffmpeg 和 ffprobe 已加入 PATH。
where ffprobe >nul 2>nul || echo [提醒] 未找到 ffprobe。它通常随 FFmpeg 一起安装。

if not exist ".dev.vars" copy /Y ".dev.vars.example" ".dev.vars" >nul
if not exist "services\analyzer\.venv\Scripts\python.exe" (
  echo [利明智耀] 正在创建 Python 3.11 环境...
  py -3.11 -m venv "services\analyzer\.venv"
  if errorlevel 1 goto :failed
)

echo [利明智耀] 正在安装视频分析依赖，首次安装时间较长...
"services\analyzer\.venv\Scripts\python.exe" -m pip install -e "services\analyzer[media]"
if errorlevel 1 goto :failed

echo [利明智耀] 视频分析服务安装完成。请先在 .dev.vars 填写模型密钥，再双击 start-analyzer.bat。
pause
exit /b 0

:missing_python
echo [错误] 未找到 Python 3.11。请安装 64 位 Python 3.11，并启用 py 启动器。
pause
exit /b 1

:failed
echo [错误] 视频分析服务安装失败，请保留本窗口中的报错信息。
pause
exit /b 1
