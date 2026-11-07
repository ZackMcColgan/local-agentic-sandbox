[CmdletBinding()]
param(
    [int]$Port = 3001,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$confPath = Join-Path $scriptDir "nginx.conf"
if (-not (Test-Path -LiteralPath $confPath)) {
    throw "nginx.conf not found at $confPath"
}

$confBytes = [System.IO.File]::ReadAllBytes($confPath)
$hasher = [System.Security.Cryptography.SHA256]::Create()
$confHash = [System.BitConverter]::ToString($hasher.ComputeHash($confBytes)).Replace("-", "").ToLowerInvariant()

$dockerArgs = @(
    "run", "-d",
    "--name", "kind-gateway",
    "--restart", "no",
    "--network", "kind",
    "-p", "127.0.0.1:${Port}:3001",
    "-v", "${confPath}:/etc/nginx/nginx.conf:ro",
    "--label", "config-hash=${confHash}",
    "--label", "gateway-port=${Port}",
    "nginx:alpine"
)

if ($DryRun) {
    [PSCustomObject]@{
        Command = "docker"
        Args    = $dockerArgs
        Network = "kind"
        Restart = "no"
        Port    = $Port
        Bind    = "127.0.0.1:${Port}:3001"
        Mount   = "${confPath}:/etc/nginx/nginx.conf:ro"
        Hash    = $confHash
    } | ConvertTo-Json -Compress
    return
}

# Check if kind-gateway container exists
$exists = & docker ps -a -q -f name=^kind-gateway$
if ($exists) {
    $inspectJson = & docker inspect kind-gateway 2>$null | Out-String
    if ($inspectJson) {
        try {
            $info = $inspectJson | ConvertFrom-Json
            $isRunning = $info[0].State.Running
            $labels = $info[0].Config.Labels
            $existingHash = $labels."config-hash"
            $existingPort = $labels."gateway-port"

            if ($isRunning -and $existingHash -eq $confHash -and "$existingPort" -eq "$Port") {
                Write-Host "ALREADY RUNNING"
                return
            }
        } catch {}
    }
    & docker rm -f kind-gateway 2>$null | Out-Null
}

# Run container
$containerId = & docker @dockerArgs
if ($LASTEXITCODE -ne 0) {
    throw "Failed to start kind-gateway container: exit code $LASTEXITCODE"
}

Write-Host "kind-gateway started: $($containerId.Substring(0, [System.Math]::Min(12, $containerId.Length))) on port $Port"
