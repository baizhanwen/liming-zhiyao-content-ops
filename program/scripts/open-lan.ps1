param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$HealthUrl
)
& "$PSScriptRoot\open-web.ps1" -Url $Url -HealthUrl $HealthUrl
exit $LASTEXITCODE
