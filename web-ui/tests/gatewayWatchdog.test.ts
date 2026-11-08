import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

// Import GatewayWatchdog from scripts/lan-bridge
// @ts-ignore
import { GatewayWatchdog } from "../../scripts/lan-bridge.js";

describe("Gateway Watchdog State Machine & Dev-Proxy Suite", () => {
  it("1. dev-proxy.js is mode-aware via ACCESS_PATH_MODE (gateway vs legacy-port-forward)", () => {
    const devProxyPath = path.resolve(__dirname, "../../scripts/dev-proxy.js");
    assert.ok(fs.existsSync(devProxyPath), "scripts/dev-proxy.js must exist");
    const code = fs.readFileSync(devProxyPath, "utf8");

    assert.match(code, /ACCESS_PATH_MODE/, "Must check process.env.ACCESS_PATH_MODE");
    assert.match(code, /gateway/, "Must support 'gateway' mode");
    assert.match(code, /legacy-port-forward/, "Must default or support 'legacy-port-forward' mode");
  });

  it("2. Watchdog does not heal when probes succeed", async () => {
    const healCalls: string[] = [];
    const watchdog = new GatewayWatchdog({
      enabled: true,
      probeFn: async () => ({ ok: true }),
      restartContainerFn: () => { healCalls.push("restart"); return { ok: true }; },
      startGatewayFn: () => { healCalls.push("start"); return { ok: true }; },
      containerExistsFn: () => true
    });

    await watchdog.step();
    await watchdog.step();
    await watchdog.step();

    assert.equal(watchdog.getState().consecutiveFailures, 0);
    assert.equal(healCalls.length, 0);
  });

  it("3. Watchdog: single probe failure increments failure count but does NOT heal", async () => {
    const healCalls: string[] = [];
    const watchdog = new GatewayWatchdog({
      enabled: true,
      probeFn: async () => ({ ok: false, error: "ECONNREFUSED" }),
      restartContainerFn: () => { healCalls.push("restart"); return { ok: true }; },
      containerExistsFn: () => true
    });

    await watchdog.step();
    assert.equal(watchdog.getState().consecutiveFailures, 1);
    assert.equal(healCalls.length, 0);
  });

  it("4. Watchdog: 2 consecutive failures triggers heal (docker restart if container exists)", async () => {
    const logs: string[] = [];
    const healCalls: string[] = [];
    const watchdog = new GatewayWatchdog({
      enabled: true,
      probeFn: async () => ({ ok: false, error: "connect ETIMEDOUT" }),
      restartContainerFn: () => { healCalls.push("docker restart kind-gateway"); return { ok: true }; },
      startGatewayFn: () => { healCalls.push("start-gateway.ps1"); return { ok: true }; },
      containerExistsFn: () => true,
      logFn: (msg: string) => logs.push(msg)
    });

    await watchdog.step(); // 1st failure
    assert.equal(healCalls.length, 0);

    await watchdog.step(); // 2nd failure -> heal
    assert.equal(healCalls.length, 1);
    assert.equal(healCalls[0], "docker restart kind-gateway");
    assert.equal(watchdog.getState().totalHeals, 1);
    assert.ok(logs.some((l) => l.includes("Action: docker restart kind-gateway")), "Must log heal action");
  });

  it("5. Watchdog: 2 consecutive failures triggers start-gateway.ps1 if container does NOT exist", async () => {
    const healCalls: string[] = [];
    const watchdog = new GatewayWatchdog({
      enabled: true,
      targetPort: 3001,
      probeFn: async () => ({ ok: false, error: "no such container" }),
      restartContainerFn: () => { healCalls.push("restart"); return { ok: true }; },
      startGatewayFn: (port: number) => { healCalls.push(`start-gateway ${port}`); return { ok: true }; },
      containerExistsFn: () => false
    });

    await watchdog.step();
    await watchdog.step();
    assert.equal(healCalls.length, 1);
    assert.equal(healCalls[0], "start-gateway 3001");
  });

  it("6. Watchdog resets consecutive failures upon successful probe", async () => {
    let probeOk = false;
    const watchdog = new GatewayWatchdog({
      enabled: true,
      probeFn: async () => ({ ok: probeOk }),
      containerExistsFn: () => true
    });

    await watchdog.step(); // fail 1
    assert.equal(watchdog.getState().consecutiveFailures, 1);

    probeOk = true;
    await watchdog.step(); // success -> resets
    assert.equal(watchdog.getState().consecutiveFailures, 0);

    probeOk = false;
    await watchdog.step(); // fail 1 again
    assert.equal(watchdog.getState().consecutiveFailures, 1);
  });

  it("7. Watchdog backoff: max 3 heals per 5-minute window, 4th logs WATCHDOG EXHAUSTED and stops healing", async () => {
    const logs: string[] = [];
    const healCalls: string[] = [];
    let currentTime = 1000000;

    const watchdog = new GatewayWatchdog({
      enabled: true,
      maxHeals: 3,
      windowMs: 300000,
      nowFn: () => currentTime,
      probeFn: async () => ({ ok: false, error: "ECONNREFUSED" }),
      restartContainerFn: () => { healCalls.push("restart"); return { ok: true }; },
      containerExistsFn: () => true,
      logFn: (msg: string) => logs.push(msg)
    });

    // Heal 1 (steps 1 & 2)
    await watchdog.step();
    await watchdog.step();
    assert.equal(healCalls.length, 1);

    // Heal 2 (steps 3 & 4)
    currentTime += 10000;
    await watchdog.step();
    await watchdog.step();
    assert.equal(healCalls.length, 2);

    // Heal 3 (steps 5 & 6)
    currentTime += 10000;
    await watchdog.step();
    await watchdog.step();
    assert.equal(healCalls.length, 3);
    assert.equal(watchdog.getState().isExhausted, false);

    // Heal 4 attempt within the 5-min window (steps 7 & 8) -> should be blocked and log WATCHDOG EXHAUSTED once
    currentTime += 10000;
    await watchdog.step();
    await watchdog.step();
    assert.equal(healCalls.length, 3, "Heals must not exceed maxHeals in window");
    assert.equal(watchdog.getState().isExhausted, true);
    assert.ok(logs.some((l) => l.includes("WATCHDOG EXHAUSTED")), "Must log WATCHDOG EXHAUSTED");

    // Advance time beyond window (> 300,000ms), heals should be allowed again
    currentTime += 350000;
    await watchdog.step();
    await watchdog.step();
    assert.equal(healCalls.length, 4, "Heals should resume after window expires");
  });

  it("8. Detection budget specification: <=11s plus container start time", () => {
    const watchdog = new GatewayWatchdog({ enabled: true });
    assert.equal(watchdog.detectionBudgetDescription, "<=11s plus container start time");
  });
});
