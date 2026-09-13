param(
    [string]$Version = "22.23.2",
    [string]$Sha256 = "ce9572ae220c345fbae2340bbb4d084e8ca5e0fe093ee7067d43094ae23be989",
    [string]$NodePathFile = "",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Liming Zhiyao requires 64-bit Windows."
}

function Test-NodeRuntime([string]$NodeExe) {
    if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { return $false }
    $npmPath = Join-Path (Split-Path -Parent $NodeExe) "npm.cmd"
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) { return $false }
    & $NodeExe -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(process.arch === 'x64' && (major > 22 || (major === 22 && minor >= 13)) ? 0 : 1)" *> $null
    return $LASTEXITCODE -eq 0
}

function Find-NodeRuntime {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path $env:LocalAppData "Programs\nodejs\node.exe")
    )) {
        if ($candidate -and -not $candidates.Contains($candidate)) { $candidates.Add($candidate) }
    }
    try {
        $command = Get-Command node.exe -ErrorAction Stop
        if ($command.Source -and -not $candidates.Contains($command.Source)) { $candidates.Add($command.Source) }
    } catch {}
    foreach ($candidate in $candidates) {
        if (Test-NodeRuntime $candidate) { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Save-NodePath([string]$NodeExe) {
    if (-not $NodePathFile) { return }
    $fullPath = [IO.Path]::GetFullPath($NodePathFile)
    $parent = Split-Path -Parent $fullPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    # setup-local.bat reads this file with cmd.exe's `set /p`. Use the active
    # Windows code page so paths under a Chinese user profile round-trip safely.
    [IO.File]::WriteAllText($fullPath, (Split-Path -Parent $NodeExe), [Text.Encoding]::Default)
}

$nodePath = Find-NodeRuntime
if ($nodePath) {
    Save-NodePath $nodePath
    $nodeVersion = & $nodePath --version
    Write-Host "[OK] Node.js $nodeVersion (x64) is ready."
    exit 0
}

if ($CheckOnly) {
    throw "64-bit Node.js 22.13 or newer and npm were not found."
}

$fileName = "node-v$Version-x64.msi"
$downloadUrl = "https://nodejs.org/dist/v$Version/$fileName"
$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) "LimingZhiyao"
$installerPath = Join-Path $downloadDirectory $fileName
New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null

function Test-NodeInstaller([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -lt 20MB) { return $false }
    $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $Sha256.ToLowerInvariant()) { return $false }
    $signature = Get-AuthenticodeSignature -FilePath $Path
    return $signature.Status -eq "Valid" -and
        $signature.SignerCertificate -and
        $signature.SignerCertificate.Subject -match "OpenJS Foundation|Node\.js Foundation"
}

if (-not (Test-NodeInstaller $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    Write-Host "[Liming Zhiyao] Downloading official Node.js $Version (x64)..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $installerPath
    } catch {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
        Write-Host "[NOTICE] Direct download failed; retrying with Windows BITS..."
        Import-Module BitsTransfer -ErrorAction Stop
        Start-BitsTransfer -Source $downloadUrl -Destination $installerPath -ErrorAction Stop
    }
}

if (-not (Test-NodeInstaller $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    throw "The downloaded Node.js installer did not pass the official publisher signature check."
}

Write-Host "[ACTION] Windows may request administrator approval to install Node.js."
$arguments = @("/i", "`"$installerPath`"", "/qn", "/norestart")
$process = Start-Process -FilePath "msiexec.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
if ($process.ExitCode -notin @(0, 1638, 3010)) {
    throw "The Node.js installer returned exit code $($process.ExitCode)."
}

$nodePath = Find-NodeRuntime
if (-not $nodePath) {
    throw "Node.js installation completed, but 64-bit Node.js 22.13 or newer with npm could not be verified."
}

Save-NodePath $nodePath
$nodeVersion = & $nodePath --version
Write-Host "[OK] Node.js $nodeVersion (x64) and npm are ready."
Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
