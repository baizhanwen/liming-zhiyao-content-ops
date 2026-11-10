param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$nodePathFile = Join-Path $ProjectRoot ".local\node.path"

& (Join-Path $PSScriptRoot "install-node22.ps1") -NodePathFile $nodePathFile
if ($LASTEXITCODE -ne 0) { throw "Node.js installation for the video collector failed." }

. (Join-Path $PSScriptRoot "analyzer-media-runtime.ps1")
. (Join-Path $PSScriptRoot "analyzer-collector-runtime.ps1")
$runtime = Import-AnalyzerCollectorRuntime -ProjectRoot $ProjectRoot -SkipDependencyCheck

Write-Host "[Liming Zhiyao] Installing the locked anonymous video collector..."
& $runtime.Npm ci --prefix $runtime.Directory --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Video collector Node dependencies could not be installed." }

Write-Host "[Liming Zhiyao] Installing this project's Chromium browser..."
& $runtime.Npm run install-browser --prefix $runtime.Directory
if ($LASTEXITCODE -ne 0) { throw "The video collector's Chromium browser could not be installed." }

Write-Host "[Liming Zhiyao] Verifying the independent Chromium launch..."
& $runtime.Node $runtime.Script --doctor
if ($LASTEXITCODE -ne 0) { throw "The video collector's Chromium browser could not launch. Run tools\check-analyzer.bat." }
Write-Host "[OK] Anonymous video collector and Chromium are ready."
