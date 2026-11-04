# Start-HostRunner.ps1 - Standalone Host Runner for Antigravity & Local Agentic Sandbox
param(
    [int]$Port = 8765
)

$configuredSecret = $env:HOST_RUNNER_SHARED_SECRET
if ([string]::IsNullOrWhiteSpace($configuredSecret)) {
    $configuredSecret = [System.Environment]::GetEnvironmentVariable("HOST_RUNNER_SHARED_SECRET", "User")
}
if ([string]::IsNullOrWhiteSpace($configuredSecret)) {
    Write-Error "HOST_RUNNER_SHARED_SECRET environment variable is missing or empty. Exiting."
    exit 1
}

function Test-FixedTimeSha256Equals([string]$secretA, [string]$secretB) {
    if ([string]::IsNullOrEmpty($secretA) -or [string]::IsNullOrEmpty($secretB)) {
        return $false
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytesA = [System.Text.Encoding]::UTF8.GetBytes($secretA)
        $bytesB = [System.Text.Encoding]::UTF8.GetBytes($secretB)
        $hashA = $sha.ComputeHash($bytesA)
        $hashB = $sha.ComputeHash($bytesB)
        if ($hashA.Length -ne $hashB.Length) {
            return $false
        }
        $diff = 0
        for ($i = 0; $i -lt $hashA.Length; $i++) {
            $diff = $diff -bor ($hashA[$i] -bxor $hashB[$i])
        }
        return ($diff -eq 0)
    } finally {
        $sha.Dispose()
    }
}

$MAX_RUNNER_OUTPUT_CHARS = 65536
$MAX_LIST_DIR_ITEMS = 500

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Starting Standalone Host Runner on http://127.0.0.1:${Port}" -ForegroundColor Green
Write-Host "  FENCES: destructive actions require explicit user approval" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:${Port}/")

try {
    $listener.Start()
} catch {
    Write-Error "HttpListener failed to bind on http://127.0.0.1:${Port}/: $_"
    exit 1
}

Write-Host "Host runner listening for authorized commands on loopback..." -ForegroundColor Cyan

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        if ($request.Url.AbsolutePath -eq "/health" -and $request.HttpMethod -eq "GET") {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok"}')
            $response.ContentType = "application/json"
            $response.StatusCode = 200
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($request.Url.AbsolutePath -eq "/execute" -and $request.HttpMethod -eq "POST") {
            $authHeader = $request.Headers["X-Host-Runner-Secret"]
            if (-not (Test-FixedTimeSha256Equals $authHeader $configuredSecret)) {
                $errBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Unauthorized"}')
                $response.ContentType = "application/json"
                $response.StatusCode = 401
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
                $response.Close()
                continue
            }

            $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd() | ConvertFrom-Json

            $tool = $body.tool
            $toolArgs = $body.args

            $effectiveCwd = (Get-Location).Path
            if ($toolArgs -and $toolArgs.PSObject.Properties['cwd'] -and -not [string]::IsNullOrWhiteSpace($toolArgs.cwd)) {
                if (-not (Test-Path -LiteralPath $toolArgs.cwd -PathType Container)) {
                    $resObj = @{ success = $false; error = "Directory not found: $($toolArgs.cwd)" }
                    $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $resObj -Depth 5))
                    $response.ContentType = "application/json"
                    $response.StatusCode = 200
                    $response.OutputStream.Write($jsonBytes, 0, $jsonBytes.Length)
                    $response.Close()
                    continue
                }
                $effectiveCwd = $toolArgs.cwd
            }

            $result = $null

            if ($tool -eq "host_run_powershell") {
                $command = $toolArgs.command
                $timeoutSeconds = 120
                if ($toolArgs -and $toolArgs.PSObject.Properties['timeoutSeconds'] -and ($toolArgs.timeoutSeconds -as [int])) {
                    $timeoutSeconds = [int]$toolArgs.timeoutSeconds
                }
                if ($timeoutSeconds -lt 1) { $timeoutSeconds = 1 }
                if ($timeoutSeconds -gt 600) { $timeoutSeconds = 600 }

                $psi = New-Object System.Diagnostics.ProcessStartInfo
                $psi.FileName = "powershell.exe"
                $psi.Arguments = "-NoProfile -NonInteractive -Command $command"
                $psi.WorkingDirectory = $effectiveCwd
                $psi.RedirectStandardOutput = $true
                $psi.RedirectStandardError = $true
                $psi.UseShellExecute = $false
                $psi.CreateNoWindow = $true

                $proc = New-Object System.Diagnostics.Process
                $proc.StartInfo = $psi

                try {
                    [void]$proc.Start()
                    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
                    $stderrTask = $proc.StandardError.ReadToEndAsync()

                    $timeoutMs = $timeoutSeconds * 1000
                    $completed = $proc.WaitForExit($timeoutMs)

                    if (-not $completed) {
                        try {
                            & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
                        } catch {}
                        try {
                            $proc.Kill()
                        } catch {}

                        [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 1000) | Out-Null
                        $partialOut = ""
                        if ($stdoutTask.IsCompleted) { $partialOut += $stdoutTask.Result }
                        if ($stderrTask.IsCompleted) { $partialOut += $stderrTask.Result }

                        $origLen = $partialOut.Length
                        $truncated = $false
                        if ($origLen -gt $MAX_RUNNER_OUTPUT_CHARS) {
                            $partialOut = $partialOut.Substring(0, $MAX_RUNNER_OUTPUT_CHARS)
                            $truncated = $true
                        }

                        $result = @{
                            success = $false
                            timedOut = $true
                            timeoutSeconds = $timeoutSeconds
                            output = $partialOut
                            truncated = $truncated
                            originalLength = $origLen
                        }
                    } else {
                        [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 2000) | Out-Null
                        $stdout = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { "" }
                        $stderr = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { "" }
                        $combined = $stdout
                        if ($stderr) {
                            if ($combined) { $combined += "`n" }
                            $combined += $stderr
                        }

                        $origLen = $combined.Length
                        $truncated = $false
                        if ($origLen -gt $MAX_RUNNER_OUTPUT_CHARS) {
                            $combined = $combined.Substring(0, $MAX_RUNNER_OUTPUT_CHARS)
                            $truncated = $true
                        }

                        $result = @{
                            success = ($proc.ExitCode -eq 0)
                            exitCode = $proc.ExitCode
                            output = $combined
                            truncated = $truncated
                            originalLength = $origLen
                        }
                    }
                } finally {
                    $proc.Dispose()
                }
            }
            elseif ($tool -eq "host_read_file") {
                $path = $toolArgs.path
                if (Test-Path -LiteralPath $path) {
                    $content = [System.IO.File]::ReadAllText($path)
                    $origLen = $content.Length
                    $truncated = $false
                    if ($origLen -gt $MAX_RUNNER_OUTPUT_CHARS) {
                        $content = $content.Substring(0, $MAX_RUNNER_OUTPUT_CHARS)
                        $truncated = $true
                    }
                    $result = @{
                        success = $true
                        content = $content
                        truncated = $truncated
                        originalLength = $origLen
                    }
                } else {
                    $result = @{ success = $false; error = "File not found: $path" }
                }
            }
            elseif ($tool -eq "host_write_file") {
                $path = $toolArgs.path
                $content = $toolArgs.content
                $parent = [System.IO.Path]::GetDirectoryName($path)
                if ($parent -and !(Test-Path -LiteralPath $parent)) {
                    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
                }
                [System.IO.File]::WriteAllText($path, $content)
                $result = @{ success = $true; path = $path }
            }
            elseif ($tool -eq "host_list_dir") {
                $rawPath = if ($toolArgs -and $toolArgs.path) { $toolArgs.path } else { "." }
                $resolvedPath = if ([System.IO.Path]::IsPathRooted($rawPath)) { $rawPath } else { [System.IO.Path]::Combine($effectiveCwd, $rawPath) }
                if (Test-Path -LiteralPath $resolvedPath) {
                    $rawItems = @(Get-ChildItem -LiteralPath $resolvedPath | Select-Object Name, Length, LastWriteTime, @{Name="IsDirectory"; Expression={$_.PSIsContainer}})
                    $origCount = $rawItems.Count
                    $truncated = $false
                    if ($origCount -gt $MAX_LIST_DIR_ITEMS) {
                        $items = @($rawItems[0..($MAX_LIST_DIR_ITEMS - 1)])
                        $truncated = $true
                    } else {
                        $items = @($rawItems)
                    }
                    $result = @{
                        success = $true
                        items = @($items)
                        truncated = $truncated
                        originalCount = $origCount
                    }
                } else {
                    $result = @{ success = $false; error = "Path not found: $rawPath" }
                }
            }
            elseif ($tool -eq "host_delete_path") {
                $path = $toolArgs.path
                if (Test-Path -LiteralPath $path) {
                    $item = Get-Item -LiteralPath $path -Force
                    if ($item -is [System.IO.DirectoryInfo] -and $toolArgs.recursive -ne $true) {
                        $result = @{ success = $false; error = "Directory deletion requires recursive: true" }
                    } else {
                        if ($item -is [System.IO.DirectoryInfo]) {
                            Remove-Item -LiteralPath $path -Recurse -Force
                        } else {
                            Remove-Item -LiteralPath $path -Force
                        }
                        $result = @{ success = $true; path = $path }
                    }
                } else {
                    $result = @{ success = $false; error = "Path not found: $path" }
                }
            }
            else {
                $result = @{ error = "Unknown host tool: $tool" }
            }

            $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result -Depth 5))
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
