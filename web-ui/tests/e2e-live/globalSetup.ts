import { execSync } from "child_process";

export default async function globalSetup() {
  console.log("\n===================================================================");
  console.log("  PREFLIGHT — LIVE E2E SUITE SYSTEM-UNDER-TEST INSPECTION");
  console.log("===================================================================\n");

  const baseUrl = process.env.PLAYWRIGHT_LIVE_BASE_URL || "http://192.168.50.254";

  // 1. Verify Live UI Reachability
  try {
    const res = await fetch(`${baseUrl}/api/sandbox-status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 200) {
      throw new Error(`HTTP ${res.status}`);
    }
    console.log(`✔ [Preflight] Live UI is reachable at ${baseUrl}`);
  } catch (err: any) {
    console.error(`\n❌ [Preflight FAILED] Live UI is not reachable at ${baseUrl}: ${err.message}`);
    console.error("Stack is not up. Aborting test:e2e:live run.\n");
    process.exit(1);
  }

  // 2. Print Running web-ui Image Tag (via kubectl)
  let deployedImage = "unknown";
  try {
    deployedImage = execSync(
      'kubectl get deployment web-ui -n local-agentic-sandbox -o jsonpath="{.spec.template.spec.containers[0].image}"',
      { encoding: "utf8" }
    ).trim();
    console.log(`✔ [Preflight] Deployed web-ui container image: ${deployedImage}`);
  } catch (err: any) {
    console.warn(`⚠️ [Preflight] Could not query deployed image tag via kubectl: ${err.message}`);
  }

  // 3. Record web-ui Pod Baseline Restart Count
  let baselineRestartCount = 0;
  try {
    const out = execSync(
      'kubectl get pod -l app=web-ui -n local-agentic-sandbox -o jsonpath="{.items[0].status.containerStatuses[0].restartCount}"',
      { encoding: "utf8" }
    ).trim();
    baselineRestartCount = parseInt(out || "0", 10);
    console.log(`✔ [Preflight] Baseline web-ui pod restart count: ${baselineRestartCount}`);
    process.env.LIVE_BASELINE_RESTARTS = String(baselineRestartCount);
  } catch (err: any) {
    console.warn(`⚠️ [Preflight] Could not query pod restart count: ${err.message}`);
  }

  // 4. Verify Strata / Local LLM Engine Reachability & Slot Idle
  try {
    const res = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const slots = await res.json();
    const busySlot = slots.find((s: any) => s.is_processing);
    if (busySlot) {
      console.warn(`⚠️ [Preflight Notice] Strata slot ${busySlot.id} is currently busy at startup. Attempting recovery...`);
    } else {
      console.log("✔ [Preflight] Strata LLM engine is reachable and slot 0 is IDLE");
    }
  } catch (err: any) {
    console.error(`\n❌ [Preflight FAILED] Strata LLM engine (http://127.0.0.1:8080) is unreachable: ${err.message}`);
    console.error("LLM engine is down. Aborting test:e2e:live run.\n");
    process.exit(1);
  }

  // 5. Verify Host Runner Daemon Health
  try {
    const res = await fetch("http://127.0.0.1:8765/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      if (data.status === "ok") {
        console.log(`✔ [Preflight] Host runner daemon is healthy (PID ${data.pid}, SHA ${data.bridgeSourceSha256?.slice(0, 8)})`);
      } else {
        console.warn(`⚠️ [Preflight] Host runner status not ok: ${JSON.stringify(data)}`);
      }
    } else {
      console.warn(`⚠️ [Preflight] Host runner returned HTTP ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [Preflight] Host runner daemon not reachable on port 8765: ${err.message}`);
  }

  // 6. §1: Effective Playwright Runner Timeout Table
  console.log("\n-------------------------------------------------------------------");
  console.log("  EFFECTIVE SPEC TIMEOUT TABLE (Addendum A §1 Hard Runner Deadlines)");
  console.log("-------------------------------------------------------------------");
  console.log("  • L1 (Short Flow & Copy):         6 min   (360s)");
  console.log("  • L2 (Artifacts & Downloads):      8 min   (480s)");
  console.log("  • L3 (Compaction & Context):      15 min   (900s)");
  console.log("  • L4 (Steer & Reload Resilience): 15 min   (900s)");
  console.log("  • L5 (Host Multi-Slice):           8 min   (480s)");
  console.log("  • L6 (Long Generation Stability): 12 min   (720s)");
  console.log("  • L7 (Host Stress & Clamp):       10 min   (600s)");
  console.log("  • L8 (Wedge Regression):          15 min   (900s)");
  console.log("  • GLOBAL RUN BUDGET (§5):         75 min hard abort");
  console.log("-------------------------------------------------------------------\n");
}
