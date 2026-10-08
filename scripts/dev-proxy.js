#!/usr/bin/env node
/**
 * Starts kubectl port-forward and the LAN bridge concurrently.
 * Handles graceful shutdown on SIGINT / Ctrl+C.
 */
const { spawn } = require("child_process");
const path = require("path");

console.log("[dev:proxy] Starting kubectl port-forward (svc/web-ui 3001:3000)...");
const k8sPf = spawn(
  "kubectl",
  ["port-forward", "svc/web-ui", "3001:3000", "-n", "local-agentic-sandbox", "--address", "0.0.0.0"],
  { stdio: "inherit", shell: true }
);

let lanBridge = null;

setTimeout(() => {
  console.log("[dev:proxy] Starting LAN bridge on ports 80 and 3000 -> 3001...");
  lanBridge = spawn(
    process.execPath,
    [path.resolve(__dirname, "lan-bridge.js")],
    { stdio: "inherit" }
  );

  lanBridge.on("exit", (code) => {
    console.log(`[dev:proxy] LAN bridge exited with code ${code}`);
  });
}, 1500);

function shutdown() {
  console.log("\n[dev:proxy] Shutting down port-forward and LAN bridge...");
  if (k8sPf) k8sPf.kill();
  if (lanBridge) lanBridge.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
