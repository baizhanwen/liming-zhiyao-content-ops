$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Test-VcRuntime {
    $runtimeKeys = @(
        "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    )
    foreach ($runtimeKey in $runtimeKeys) {
        try {
            $runtime = Get-ItemProperty -LiteralPath $runtimeKey -ErrorAction Stop
            if ($runtime.Installed -eq 1 -and $runtime.Major -ge 14) { return $true }
        } catch {}
    }
    return $false
}

if (Test-VcRuntime) {
    Write-Host "[OK] Microsoft Visual C++ x64 runtime is installed."
    exit 0
}

$downloadUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) "LimingZhiyao"
$installerPath = Join-Path $downloadDirectory "vc_redist.x64.exe"
New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null

function Test-MicrosoftInstaller([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -lt 10MB) { return $false }
    $signature = Get-AuthenticodeSignature -FilePath $Path
    return $signature.Status -eq "Valid" -and $signature.SignerCertificate.Subject -match "Microsoft Corporation"
}

if (-not (Test-MicrosoftInstaller $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    Write-Host "[Liming Zhiyao] Downloading the Microsoft Visual C++ x64 runtime..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $installerPath
    } catch {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
        Import-Module BitsTransfer -ErrorAction Stop
        Start-BitsTransfer -Source $downloadUrl -Destination $installerPath -ErrorAction Stop
    }
}

if (-not (Test-MicrosoftInstaller $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    throw "The Visual C++ installer did not pass the official Microsoft signature check."
}

Write-Host "[ACTION] Windows may request administrator approval for the Microsoft runtime."
$process = Start-Process -FilePath $installerPath -ArgumentList @("/install", "/quiet", "/norestart") -Verb RunAs -Wait -PassThru
if ($process.ExitCode -notin @(0, 1638, 3010)) {
    throw "The Visual C++ installer returned exit code $($process.ExitCode)."
}
if (-not (Test-VcRuntime)) {
    throw "Visual C++ installation completed, but the x64 runtime was not detected."
}

Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
Write-Host "[OK] Microsoft Visual C++ x64 runtime is ready."
