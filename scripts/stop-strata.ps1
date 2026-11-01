Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -in @("strata.exe", "strata-vision.exe") -or
    $_.CommandLine -like "*serve.server*--engine*strata*"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
