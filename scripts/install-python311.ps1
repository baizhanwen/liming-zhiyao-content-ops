param(
    [string]$Version = "3.11.9"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Liming Zhiyao video analysis requires 64-bit Windows."
}

$fileName = "python-$Version-amd64.exe"
$mirrorDownloadUrl = "https://mirrors.aliyun.com/python-release/windows/$fileName"
$officialDownloadUrl = "https://www.python.org/ftp/python/$Version/$fileName"
$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) "LimingZhiyao"
$installerPath = Join-Path $downloadDirectory $fileName
New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null

function Test-PythonInstaller([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -lt 20MB) { return $false }
    $signature = Get-AuthenticodeSignature -FilePath $Path
    return $signature.Status -eq "Valid" -and $signature.SignerCertificate.Subject -match "Python Software Foundation"
}

if (-not (Test-PythonInstaller $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $downloadSources = @(
        @{ Label = "Aliyun Python mirror"; Url = $mirrorDownloadUrl },
        @{ Label = "official python.org"; Url = $officialDownloadUrl }
    )
    foreach ($source in $downloadSources) {
        Write-Host "[Liming Zhiyao] Downloading Python $Version (64-bit) from $($source.Label)..."
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $source.Url -OutFile $installerPath
        } catch {
            Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
            Write-Host "[NOTICE] Direct download from $($source.Label) failed; retrying with Windows BITS..."
            try {
                Import-Module BitsTransfer -ErrorAction Stop
                Start-BitsTransfer -Source $source.Url -Destination $installerPath -ErrorAction Stop
            } catch {
                Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
            }
        }
        if (Test-PythonInstaller $installerPath) {
            Write-Host "[OK] Python installer passed the official publisher signature check."
            break
        }
        Write-Host "[NOTICE] $($source.Label) did not provide a valid signed installer; trying the next source."
    }
}

if (-not (Test-PythonInstaller $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    throw "The downloaded Python installer did not pass the official publisher signature check."
}

Write-Host "[Liming Zhiyao] Installing Python $Version for the current Windows user..."
$arguments = @(
    "/quiet",
    "InstallAllUsers=0",
    "PrependPath=1",
    "Include_launcher=1",
    "InstallLauncherAllUsers=0",
    "Include_test=0",
    "SimpleInstall=1"
)
$process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -notin @(0, 3010)) {
    throw "The Python installer returned exit code $($process.ExitCode)."
}

$pythonPath = Join-Path $env:LocalAppData "Programs\Python\Python311\python.exe"
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "Python installation completed, but python.exe was not found at $pythonPath."
}

& $pythonPath -c "import platform,sys; assert sys.version_info[:2] == (3, 11) and sys.maxsize > 2**32; print('[OK] Python ' + sys.version.split()[0] + ' / ' + platform.architecture()[0])"
if ($LASTEXITCODE -ne 0) {
    throw "The installed Python runtime failed the 64-bit Python 3.11 verification."
}

Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
