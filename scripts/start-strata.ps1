$strataRoot = Join-Path $env:LOCALAPPDATA "Strata"
$pythonExe = Join-Path $strataRoot "terminal\current\python\python.exe"
$configPath = Join-Path $strataRoot "launch\hermes-strata-gyro-64k.json"
$cmd = "`"$pythonExe`" -m serve.server --engine strata --config `"$configPath`" --host 127.0.0.1 --port 8080 --parallel 1"
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmd
    CurrentDirectory = (Join-Path $strataRoot "terminal\0.1.51")
}
$res.ProcessId
