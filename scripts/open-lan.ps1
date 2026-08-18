param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$HealthUrl
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
