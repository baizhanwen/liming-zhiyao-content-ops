@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

call :parse_arguments %*
if errorlevel 1 exit /b 2

call :find_python
if defined CHECK_PYTHON_ONLY goto :check_python
if not defined PYTHON_EXE goto :install_python

:setup_analyzer
echo [Liming Zhiyao] Checking FFmpeg and ffprobe...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\install-ffmpeg.ps1" -PathFile "%PROJECT_ROOT%\.local\ffmpeg.path"
if errorlevel 1 goto :ffmpeg_failed
if exist ".local\ffmpeg.path" (
  set "FFMPEG_PATH="
  set /p FFMPEG_PATH=<".local\ffmpeg.path"
  if defined FFMPEG_PATH set "PATH=%FFMPEG_PATH%;%PATH%"
)
where ffmpeg >nul 2>nul || goto :ffmpeg_failed
where ffprobe >nul 2>nul || goto :ffmpeg_failed
ffmpeg -version >nul 2>nul || goto :ffmpeg_failed
ffprobe -version >nul 2>nul || goto :ffmpeg_failed
echo [OK] FFmpeg and ffprobe passed executable verification.

echo [Liming Zhiyao] Checking the Microsoft Visual C++ runtime...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\install-vcredist.ps1"
if errorlevel 1 goto :failed

if not exist ".dev.vars" copy /Y ".dev.vars.example" ".dev.vars" >nul
if not exist "services\analyzer\.venv\Scripts\python.exe" (
  echo [Liming Zhiyao] Creating the Python 3.11 environment...
  "%PYTHON_EXE%" -m venv "services\analyzer\.venv"
  if errorlevel 1 goto :failed
)

call :install_analyzer_dependencies
if errorlevel 1 goto :failed

echo [OK] Analyzer environment setup completed.
call :start_analyzer_if_app_is_running
pause
exit /b 0

:install_analyzer_dependencies
set "PIP_CONFIG_FILE=NUL"
set "PIP_INDEX_URL="
set "PIP_EXTRA_INDEX_URL="
set "PIP_CONSTRAINT="
set "PIP_REQUIRE_HASHES="
set "PIP_FIND_LINKS="
set "PIP_NO_INDEX="
if defined LocalAppData (
  set "PIP_CACHE_DIR=%LocalAppData%\LimingZhiyao\pip-cache"
) else (
  set "PIP_CACHE_DIR=%TEMP%\LimingZhiyao-pip-cache"
)
set "PYTHON_CONSTRAINT=%PROJECT_ROOT%\services\analyzer\constraints-windows.txt"
if not exist "%PYTHON_CONSTRAINT%" (
  echo [ERROR] The analyzer dependency constraint file is missing.
  exit /b 1
)
echo [Liming Zhiyao] Preparing the bundled Python package installer...
"services\analyzer\.venv\Scripts\python.exe" -m ensurepip --upgrade
if errorlevel 1 exit /b 1
echo [Liming Zhiyao] Python package source: %PYPI_PRIMARY_LABEL%
call :pip_install --constraint "%PYTHON_CONSTRAINT%" --upgrade "pip==26.2.1" "setuptools==81.0.0" "wheel==0.48.0"
if errorlevel 1 exit /b 1
set "REPAIR_OPENCV_NAMESPACE="
"services\analyzer\.venv\Scripts\python.exe" -c "import importlib.metadata as m,sys; names=('opencv-python','opencv-python-headless','opencv-contrib-python-headless','scenedetect'); sys.exit(0 if any(m.packages_distributions().get(name.replace('-','_')) for name in names) or any(any(dist.metadata.get('Name','').lower()==name for dist in m.distributions()) for name in names) else 1)" >nul 2>nul
if not errorlevel 1 (
  echo [Liming Zhiyao] Removing incompatible legacy video packages...
  set "REPAIR_OPENCV_NAMESPACE=1"
  "services\analyzer\.venv\Scripts\python.exe" -m pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python-headless scenedetect >nul 2>nul
)
echo [Liming Zhiyao] Installing video analysis dependencies...
echo [NOTICE] Downloaded packages are kept in %PIP_CACHE_DIR% for retries and future repairs.
call :pip_install --constraint "%PYTHON_CONSTRAINT%" --upgrade "services\analyzer[media]"
if errorlevel 1 (
  echo [NOTICE] Both configured package sources failed. Clearing pip cache and retrying once...
  "services\analyzer\.venv\Scripts\python.exe" -m pip cache purge >nul 2>nul
  call :pip_install --no-cache-dir --constraint "%PYTHON_CONSTRAINT%" --upgrade "services\analyzer[media]"
  if errorlevel 1 exit /b 1
)
if defined REPAIR_OPENCV_NAMESPACE (
  echo [Liming Zhiyao] Rebuilding the single supported OpenCV namespace...
  call :pip_install --constraint "%PYTHON_CONSTRAINT%" --force-reinstall --no-deps "opencv-contrib-python==4.10.0.84"
  if errorlevel 1 exit /b 1
)
echo [Liming Zhiyao] Verifying the Windows OCR runtime compatibility pin...
"services\analyzer\.venv\Scripts\python.exe" -c "import importlib.metadata as m,sys; version=m.version('paddlepaddle'); print('PaddlePaddle ' + version); sys.exit(0 if version == '3.2.0' else 1)"
if errorlevel 1 (
  echo [ERROR] PaddlePaddle 3.2.0 was not installed. OCR cannot start safely on Windows.
  exit /b 1
)
echo [Liming Zhiyao] Verifying the complete locked analyzer runtime...
"services\analyzer\.venv\Scripts\python.exe" -c "import importlib.metadata as m,sys; expected={'funasr':'1.4.1','paddleocr':'3.7.0','paddlepaddle':'3.2.0','paddlex':'3.7.2','torch':'2.11.0','torchaudio':'2.11.0','mcp':'2.1.0','mcp-types':'2.1.0','minimax-coding-plan-mcp':'0.0.5'}; wrong=[f'{name}={m.version(name)} expected {version}' for name,version in expected.items() if m.version(name)!=version]; print('Analyzer runtime versions are locked.' if not wrong else '; '.join(wrong)); sys.exit(1 if wrong else 0)"
if errorlevel 1 exit /b 1
"services\analyzer\.venv\Scripts\python.exe" -m pip check
if errorlevel 1 exit /b 1
echo [Liming Zhiyao] Loading native analyzer modules...
"services\analyzer\.venv\Scripts\python.exe" -c "import importlib.metadata as m,importlib.util,platform,sys; assert platform.machine().upper() in ('AMD64','X86_64'); forbidden=('opencv-python','opencv-python-headless','opencv-contrib-python-headless','scenedetect'); installed={dist.metadata.get('Name','').lower() for dist in m.distributions()}; assert not installed.intersection(forbidden), 'incompatible video packages remain installed'; import torch,torchaudio,paddle,cv2,mcp; from paddleocr import PaddleOCR; assert importlib.util.find_spec('minimax_mcp.server'), 'MiniMax MCP server entrypoint is unavailable'; assert m.version('opencv-contrib-python') == '4.10.0.84'; assert cv2.__version__ == '4.10.0'; print('Native analyzer and MiniMax MCP modules loaded on ' + platform.machine() + ' / Python ' + platform.python_version())"
if errorlevel 1 (
  echo [ERROR] A native analyzer module could not be loaded. Run tools\check-analyzer.bat and send the result to support.
  exit /b 1
)
exit /b 0

:pip_install
"services\analyzer\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --prefer-binary --retries 20 --timeout 120 --resume-retries 20 --index-url "%PYPI_PRIMARY%" %*
if not errorlevel 1 exit /b 0
if not defined PYPI_FALLBACK exit /b 1
echo.
echo [NOTICE] %PYPI_PRIMARY_LABEL% failed. Keeping the download cache and retrying with official PyPI...
"services\analyzer\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --prefer-binary --retries 20 --timeout 120 --resume-retries 20 --index-url "%PYPI_FALLBACK%" %*
exit /b %errorlevel%

:parse_arguments
set "CHECK_PYTHON_ONLY="
set "PYPI_PRIMARY=https://mirrors.aliyun.com/pypi/simple"
set "PYPI_PRIMARY_LABEL=Aliyun PyPI mirror"
set "PYPI_FALLBACK=https://pypi.org/simple"
:parse_arguments_loop
if "%~1"=="" exit /b 0
if /i "%~1"=="--check-python" (
  set "CHECK_PYTHON_ONLY=1"
  shift
  goto :parse_arguments_loop
)
if /i "%~1"=="--index" goto :parse_index
echo [ERROR] Unknown setup option: %~1
echo Usage: tools\setup-analyzer.bat [--index aliyun^|official] [--check-python]
exit /b 1

:parse_index
if "%~2"=="" (
  echo [ERROR] --index requires aliyun or official.
  exit /b 1
)
if /i "%~2"=="aliyun" goto :use_aliyun
if /i "%~2"=="official" goto :use_official
echo [ERROR] Unsupported Python package source: %~2
echo Usage: tools\setup-analyzer.bat [--index aliyun^|official] [--check-python]
exit /b 1

:use_aliyun
set "PYPI_PRIMARY=https://mirrors.aliyun.com/pypi/simple"
set "PYPI_PRIMARY_LABEL=Aliyun PyPI mirror"
set "PYPI_FALLBACK=https://pypi.org/simple"
shift
shift
goto :parse_arguments_loop

:use_official
set "PYPI_PRIMARY=https://pypi.org/simple"
set "PYPI_PRIMARY_LABEL=official PyPI"
set "PYPI_FALLBACK="
shift
shift
goto :parse_arguments_loop

:start_analyzer_if_app_is_running
if not exist ".local\app.port" (
  echo [NEXT] Run start-local.bat. The analyzer will start with the web app.
  exit /b 0
)
set "LOCAL_APP_PORT="
set /p LOCAL_APP_PORT=<".local\app.port"
if not defined LOCAL_APP_PORT (
  echo [NEXT] Run start-local.bat. The analyzer will start with the web app.
  exit /b 0
)
echo [Liming Zhiyao] Starting the analyzer for the running local app...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\start-analyzer-background.ps1" -BaseUrl "http://127.0.0.1:%LOCAL_APP_PORT%"
if errorlevel 1 (
  echo [NOTICE] The environment is installed, but the analyzer could not start.
  if exist ".local\analyzer-start-error.txt" type ".local\analyzer-start-error.txt"
  echo [NEXT] Complete the model settings in .dev.vars, then run tools\start-analyzer.bat.
  exit /b 0
)
echo [OK] The analyzer is running in the background.
exit /b 0

:install_python
echo.
echo [NOTICE] 64-bit Python 3.11 was not found.
echo [ACTION] Downloading and installing Python 3.11 from the Aliyun mirror with official fallback...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\install-python311.ps1"
if errorlevel 1 goto :python_install_failed
call :find_python
if not defined PYTHON_EXE goto :python_install_failed
echo [OK] Python 3.11 is ready: %PYTHON_EXE%
goto :setup_analyzer

:check_python
if not defined PYTHON_EXE (
  echo [ERROR] 64-bit Python 3.11 was not found.
  exit /b 1
)
echo [OK] Python 3.11 found: %PYTHON_EXE%
"%PYTHON_EXE%" -c "import platform,sys; print(sys.version.split()[0] + ' / ' + platform.architecture()[0])"
exit /b 0

:find_python
set "PYTHON_EXE="
for /f "usebackq delims=" %%P in (`py -3.11 -c "import platform,sys; print(sys.executable if sys.maxsize.bit_length() == 63 and platform.machine().upper() in ('AMD64','X86_64') else '')" 2^>nul`) do if not "%%P"=="" set "PYTHON_EXE=%%P"
if defined PYTHON_EXE exit /b 0
for %%P in ("%LocalAppData%\Programs\Python\Python311\python.exe" "%ProgramFiles%\Python311\python.exe" "%ProgramFiles(x86)%\Python311\python.exe") do (
  if exist "%%~P" for /f "delims=" %%V in ('"%%~P" -c "import platform,sys; print(sys.executable if sys.version_info[:2] == (3, 11) and sys.maxsize.bit_length() == 63 and platform.machine().upper() in ('AMD64','X86_64') else '')" 2^>nul') do if not "%%V"=="" set "PYTHON_EXE=%%V"
)
if defined PYTHON_EXE exit /b 0
for /f "delims=" %%P in ('where python 2^>nul') do (
  if not defined PYTHON_EXE for /f "delims=" %%V in ('"%%P" -c "import platform,sys; print(sys.executable if sys.version_info[:2] == (3, 11) and sys.maxsize.bit_length() == 63 and platform.machine().upper() in ('AMD64','X86_64') else '')" 2^>nul') do if not "%%V"=="" set "PYTHON_EXE=%%V"
)
exit /b 0

:python_install_failed
echo.
echo [ERROR] Python 3.11 could not be installed automatically.
echo Check the internet connection and Windows security prompts, then run this file again.
pause
exit /b 1

:failed
echo [ERROR] Analyzer setup failed. Review the error shown above.
pause
exit /b 1

:ffmpeg_failed
echo.
echo [ERROR] FFmpeg and ffprobe could not be installed or verified.
echo Windows Package Manager is required. Install or update App Installer, then run this file again.
pause
exit /b 1
