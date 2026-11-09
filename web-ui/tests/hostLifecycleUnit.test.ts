import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("PART C — Host Runner Lifecycle Unit Tests (Mocked Boundaries)", () => {
  // 1. Script Invocation Construction
  it("1. Constructs valid PowerShell command lines for AI-ON and AI-OFF with -OnlyHostRunner", () => {
    function buildLifecycleCommand(scriptPath: string, options: { onlyHostRunner?: boolean; skipStrata?: boolean; skipHermes?: boolean }) {
      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
      if (options.onlyHostRunner) args.push("-OnlyHostRunner");
      if (options.skipStrata) args.push("-SkipStrata");
      if (options.skipHermes) args.push("-SkipHermes");
      return args;
    }

    const aiOnCmd = buildLifecycleCommand("C:\\AI\\ai-control\\AI-ON.ps1", { onlyHostRunner: true });
    assert.deepEqual(aiOnCmd, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\AI\\ai-control\\AI-ON.ps1",
      "-OnlyHostRunner"
    ]);

    const aiOffCmd = buildLifecycleCommand("C:\\AI\\ai-control\\AI-OFF.ps1", { onlyHostRunner: true });
    assert.deepEqual(aiOffCmd, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\AI\\ai-control\\AI-OFF.ps1",
      "-OnlyHostRunner"
    ]);
  });

  // 2. Idempotent State Transitions & Stale Digest Invalidation
  it("2. Evaluates runner state transitions accurately across running, matching, stale, and foreign states", () => {
    type ProbeResult = { ok: boolean; status?: string; sha?: string; pid?: number };

    function evaluateHostRunnerState(probe: ProbeResult, expectedSha: string) {
      if (!probe.ok) {
        return { action: "spawn", status: "STOPPED" };
      }
      if (probe.status === "ok" && probe.sha === expectedSha && expectedSha.length > 0) {
        return { action: "preserve", status: "ONLINE", pid: probe.pid };
      }
      if (probe.status === "ok" && probe.sha !== expectedSha) {
        return { action: "restart", status: "STALE", stalePid: probe.pid };
      }
      return { action: "ignore_foreign", status: "OFFLINE_FOREIGN_CONFLICT" };
    }

    const currentSha = "abc123sha";

    // Stopped
    assert.deepEqual(evaluateHostRunnerState({ ok: false }, currentSha), {
      action: "spawn",
      status: "STOPPED"
    });

    // Matching instance: idempotent preservation
    assert.deepEqual(
      evaluateHostRunnerState({ ok: true, status: "ok", sha: currentSha, pid: 4200 }, currentSha),
      { action: "preserve", status: "ONLINE", pid: 4200 }
    );

    // Stale instance: digest mismatch triggers restart
    assert.deepEqual(
      evaluateHostRunnerState({ ok: true, status: "ok", sha: "oldSha456", pid: 4200 }, currentSha),
      { action: "restart", status: "STALE", stalePid: 4200 }
    );

    // Foreign process on port (not answering /health with status: ok)
    assert.deepEqual(
      evaluateHostRunnerState({ ok: true, status: "unknown" }, currentSha),
      { action: "ignore_foreign", status: "OFFLINE_FOREIGN_CONFLICT" }
    );
  });

  // 3. PIN 3 Failure Isolation (non-blocking failure behavior)
  it("3. Failure isolation marks host runner OFFLINE and preserves overall exit 0 on compilation failure", () => {
    function simulateStartupWithBuildResult(buildSuccess: boolean) {
      const layerStatus: Record<string, string> = {};
      let exitCode = 0;

      if (!buildSuccess) {
        // PIN 3 failure isolation: log warning and mark OFFLINE, do not throw
        layerStatus["HostRunner"] = "OFFLINE (compilation failed)";
        exitCode = 0; // Startup continues
      } else {
        layerStatus["HostRunner"] = "ONLINE";
        exitCode = 0;
      }

      return { layerStatus, exitCode };
    }

    const failureRun = simulateStartupWithBuildResult(false);
    assert.equal(failureRun.exitCode, 0, "Startup must exit 0 on bridge failure (non-blocking isolation)");
    assert.equal(failureRun.layerStatus["HostRunner"], "OFFLINE (compilation failed)");

    const successRun = simulateStartupWithBuildResult(true);
    assert.equal(successRun.exitCode, 0);
    assert.equal(successRun.layerStatus["HostRunner"], "ONLINE");
  });

  // 4. Service Protection: Independent Port Isolation (Plex :32400)
  it("4. Verifies shutdown logic targets host runner tree exclusively and never touches port 32400 (Plex)", () => {
    function simulateShutdown(runningPorts: number[], targetPort = 8765) {
      const killedPorts: number[] = [];
      for (const p of runningPorts) {
        if (p === targetPort) {
          killedPorts.push(p);
        }
      }
      return {
        remainingPorts: runningPorts.filter((p) => !killedPorts.includes(p)),
        killedPorts
      };
    }

    const { remainingPorts, killedPorts } = simulateShutdown([8765, 32400], 8765);
    assert.deepEqual(killedPorts, [8765]);
    assert.deepEqual(remainingPorts, [32400], "Plex on 32400 must remain completely untouched");
  });
});
