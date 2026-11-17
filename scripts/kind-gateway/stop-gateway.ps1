[CmdletBinding()]
param()

$ErrorActionPreference = "SilentlyContinue"
docker rm -f kind-gateway 2>$null | Out-Null
Write-Host "kind-gateway stopped"
