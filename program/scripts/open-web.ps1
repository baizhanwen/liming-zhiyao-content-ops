param(
    [string]$Url = "http://127.0.0.1:3000",
    [string]$HealthUrl = $Url
)
$ErrorActionPreference = "SilentlyContinue"
$healthEndpoint = "$($HealthUrl.TrimEnd('/'))/api/health"

for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthEndpoint -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
        & "$PSScriptRoot\start-analyzer-background.ps1" -BaseUrl $HealthUrl
        Start-Process $Url
        exit 0
    }
    Start-Sleep -Seconds 1
}
exit 1
