import { spawn, execSync, type ChildProcess } from "child_process";

const POWERSHELL_WRAPPER_SCRIPT = [
  "$PSNativeCommandUseErrorActionPreference = $false",
  "$ErrorActionPreference = 'Continue'",
  "$global:LASTEXITCODE = 0",
  "$__hostPsHadTerminatingError = $false",
  "$__hostPsLastOk = $true",
  "try {",
  "  $__hostPsCmd = $env:__HOST_PS_CMD",
  "  Remove-Item Env:__HOST_PS_CMD -ErrorAction SilentlyContinue",
  "  & ([scriptblock]::Create($__hostPsCmd))",
  "  $__hostPsLastOk = $?",
  "} catch {",
  "  if ($_.FullyQualifiedErrorId -eq 'NativeCommandError') {",
  "    $__hostPsHadTerminatingError = $true",
  "    [Console]::Error.WriteLine($_.Exception.Message)",
  "  } else {",
  "    $__hostPsHadTerminatingError = $true",
  "    [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())",
  "  }",
  "}",
  "if ($__hostPsHadTerminatingError) {",
  "  $__hostPsEc = if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }",
  "  exit $__hostPsEc",
  "}",
  "if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {",
  "  exit $LASTEXITCODE",
  "}",
  "if (-not $__hostPsLastOk) {",
  "  exit 1",
  "}",
  "exit 0",
].join("\n");

/**
 * Spawns Windows PowerShell 5.1 with a wrapper that keeps native command stderr
 * progress (e.g. git fetch/push/checkout, npm) from terminating as NativeCommandError
 * even when the caller sets $ErrorActionPreference = 'Stop', while preserving real
 * native $LASTEXITCODE and PowerShell terminating errors.
 */
export function spawnWrappedPowerShell(command: string, cwd: string): ChildProcess {
  return spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-Command",
      POWERSHELL_WRAPPER_SCRIPT,
    ],
    {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, __HOST_PS_CMD: command },
    }
  );
}

/**
 * Terminates a PowerShell process and any surviving child processes in its tree.
 */
export function killPowerShellProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {}
    try {
      const check = execSync(
        `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }"`,
        { encoding: "utf8", timeout: 3000 }
      );
      const pids = check
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of pids) {
        try {
          execSync(`taskkill /PID ${p} /T /F`, { stdio: "ignore" });
        } catch {}
      }
    } catch {}
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
}

/**
 * Clamps long command output while preserving the head (20%) and tail (~80%)
 * so final exit errors and test summaries are never cut off.
 */
export function clampCommandOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const headChars = Math.floor(maxChars * 0.2);
  const probeMarker = `\n... [truncated ${text.length} chars] ...\n`;
  if (headChars + probeMarker.length >= maxChars) {
    return text.slice(text.length - maxChars);
  }
  const initialTail = maxChars - headChars - probeMarker.length;
  const omitted = text.length - headChars - initialTail;
  const marker = `\n... [truncated ${omitted} chars] ...\n`;
  const tailChars = maxChars - headChars - marker.length;
  return text.slice(0, headChars) + marker + text.slice(text.length - tailChars);
}
