#!/usr/bin/env node
/**
 * Starts kubectl port-forward and the LAN bridge concurrently,
 * or runs in gateway mode where kind-gateway handles the cluster path.
 * Handles graceful shutdown on SIGINT / Ctrl+C.
 */
const { spawn } = require("child_process");
const path = require("path");

const accessPathMode = (process.env.ACCESS_PATH_MODE || "legacy-port-forward").trim().toLowerCase();
const isGatewayMode = accessPathMode === "gateway";

let k8sPf = null;
let lanBridge = null;

if (isGatewayMode) {
  console.log("[dev:proxy] Mode: gateway (kind-gateway on :3001; skipping kubectl port-forward)");
  console.log("[dev:proxy] Starting LAN bridge on ports 80 and 3000 -> 3001...");
  lanBridge = spawn(
    process.execPath,
    [path.resolve(__dirname, "lan-bridge.js")],
    {
      stdio: "inherit",
      env: { ...process.env, ACCESS_PATH_MODE: "gateway" }
    }
  );

  lanBridge.on("exit", (code) => {
    console.log(`[dev:proxy] LAN bridge exited with code ${code}`);
  });
} else {
  console.log("[dev:proxy] Mode: legacy-port-forward (starting kubectl port-forward svc/web-ui 3001:3000)...");
  k8sPf = spawn(
    "kubectl",
    ["port-forward", "svc/web-ui", "3001:3000", "-n", "local-agentic-sandbox", "--address", "0.0.0.0"],
    { stdio: "inherit", shell: true }
  );

  setTimeout(() => {
    console.log("[dev:proxy] Starting LAN bridge on ports 80 and 3000 -> 3001...");
    lanBridge = spawn(
      process.execPath,
      [path.resolve(__dirname, "lan-bridge.js")],
      {
        stdio: "inherit",
        env: { ...process.env, ACCESS_PATH_MODE: "legacy-port-forward" }
      }
    );

    lanBridge.on("exit", (code) => {
      console.log(`[dev:proxy] LAN bridge exited with code ${code}`);
    });
  }, 1500);
}

function shutdown() {
  console.log("\n[dev:proxy] Shutting down services...");
  if (k8sPf) k8sPf.kill();
  if (lanBridge) lanBridge.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
