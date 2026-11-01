$cmd = '"C:\Users\zackm\AppData\Local\Strata\terminal\current\python\python.exe" -m serve.server --engine strata --config "C:\Users\zackm\AppData\Local\Strata\launch\hermes-strata-gyro-64k.json" --host 127.0.0.1 --port 8080 --parallel 1'
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmd
    CurrentDirectory = "C:\Users\zackm\AppData\Local\Strata\terminal\0.1.51"
}
$res.ProcessId
