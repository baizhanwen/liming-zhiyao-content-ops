$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$python = Join-Path $projectRoot "services\analyzer\.venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "The analyzer is not installed. Run setup-analyzer.bat first."
}

$extensionUrl = "https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
Write-Host ""
Write-Host "Edge protects its cookie database from external programs on Windows."
Write-Host "Use the official yt-dlp-recommended 'Get cookies.txt LOCALLY' extension:"
Write-Host $extensionUrl
Write-Host ""
Write-Host "1. Install the extension in Edge once."
Write-Host "2. Open douyin.com, then export the current site's cookies in Netscape format."
Write-Host "3. Select the exported cookies.txt file in the dialog below."
Write-Host ""

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Select the cookies.txt file exported from douyin.com"
$dialog.Filter = "Cookie text files (*.txt)|*.txt|All files (*.*)|*.*"
$downloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads"
if (Test-Path -LiteralPath $downloads) { $dialog.InitialDirectory = $downloads }

if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "[ACTION] No file was selected. The extension page will open now."
    Start-Process $extensionUrl
    exit 2
}

& $python -m liming_analyzer.cookie_snapshot --import-file $dialog.FileName --output ".local\douyin-cookies.txt"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "[OK] Cookie snapshot refreshed. Edge may stay open throughout analysis."
Write-Host "[SECURITY] Delete the exported cookies.txt from Downloads after this succeeds."
Write-Host "[NEXT] Press Ctrl+C in the old analyzer window, then run start-analyzer.bat once."
try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
        Start-Process "http://127.0.0.1:3000/analysis"
    }
} catch {}
