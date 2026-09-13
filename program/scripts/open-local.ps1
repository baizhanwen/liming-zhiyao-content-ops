param([string]$Url = "http://127.0.0.1:3000")
& "$PSScriptRoot\open-web.ps1" -Url $Url -HealthUrl $Url
exit $LASTEXITCODE
