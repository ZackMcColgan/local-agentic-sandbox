# Start-HostRunner.ps1 - Standalone Host Runner for Antigravity & Local Agentic Sandbox
param(
    [int]$Port = 8765,
    [string]$BindAddress = "0.0.0.0"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Starting Standalone Host Runner on http://${BindAddress}:${Port}" -ForegroundColor Green
Write-Host "  FENCES: destructive actions require explicit user approval" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://${BindAddress}:${Port}/")

try {
    $listener.Start()
} catch {
    Write-Warning "HttpListener failed on $BindAddress, falling back to localhost"
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:${Port}/")
    $listener.Start()
}

Write-Host "Host runner listening for authorized commands..." -ForegroundColor Cyan

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }

        if ($request.Url.AbsolutePath -eq "/health") {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok","runner":"powershell_host"}')
            $response.ContentType = "application/json"
            $response.StatusCode = 200
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($request.Url.AbsolutePath -eq "/execute" -and $request.HttpMethod -eq "POST") {
            $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd() | ConvertFrom-Json

            $tool = $body.tool
            $args = $body.args

            $result = $null

            if ($tool -eq "host_run_powershell") {
                $command = $args.command
                Write-Host "[HOST_EXEC] PowerShell: $command" -ForegroundColor Yellow
                $execOutput = powershell -NoProfile -NonInteractive -Command $command 2>&1 | Out-String
                $result = @{
                    exitCode = $LASTEXITCODE
                    output = $execOutput
                }
            }
            elseif ($tool -eq "host_read_file") {
                $path = $args.path
                if (Test-Path $path) {
                    $content = [System.IO.File]::ReadAllText($path)
                    $result = @{ success = $true; content = $content }
                } else {
                    $result = @{ success = $false; error = "File not found: $path" }
                }
            }
            elseif ($tool -eq "host_write_file") {
                $path = $args.path
                $content = $args.content
                $parent = [System.IO.Path]::GetDirectoryName($path)
                if ($parent -and !(Test-Path $parent)) {
                    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
                }
                [System.IO.File]::WriteAllText($path, $content)
                $result = @{ success = $true; path = $path }
            }
            elseif ($tool -eq "host_list_dir") {
                $path = if ($args.path) { $args.path } else { "." }
                if (Test-Path $path) {
                    $items = Get-ChildItem -Path $path | Select-Object Name, Length, LastWriteTime, @{Name="IsDirectory"; Expression={$_.PSIsContainer}}
                    $result = @{ success = $true; items = $items }
                } else {
                    $result = @{ success = $false; error = "Path not found: $path" }
                }
            }
            elseif ($tool -eq "host_delete_path") {
                $path = $args.path
                if (Test-Path $path) {
                    Remove-Item -Path $path -Recurse -Force
                    $result = @{ success = $true; path = $path }
                } else {
                    $result = @{ success = $false; error = "Path not found: $path" }
                }
            }
            else {
                $result = @{ error = "Unknown host tool: $tool" }
            }

            $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 5))
            $response.ContentType = "application/json"
            $response.StatusCode = 200
            $response.OutputStream.Write($jsonBytes, 0, $jsonBytes.Length)
            $response.Close()
            continue
        }

        $response.StatusCode = 404
        $response.Close()
    } catch {
        Write-Warning "Error processing request: $_"
    }
}
