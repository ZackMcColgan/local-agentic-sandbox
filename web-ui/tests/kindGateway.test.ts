import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("kind-gateway Assets & Launcher Suite", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const gatewayDir = path.resolve(repoRoot, "scripts/kind-gateway");
  const nginxConfPath = path.resolve(gatewayDir, "nginx.conf");
  const startScriptPath = path.resolve(gatewayDir, "start-gateway.ps1");
  const stopScriptPath = path.resolve(gatewayDir, "stop-gateway.ps1");

  it("1. nginx.conf contains all required proxy, streaming, buffer, timeout, and dynamic resolver directives", () => {
    assert.ok(fs.existsSync(nginxConfPath), "nginx.conf must exist in scripts/kind-gateway/");
    const conf = fs.readFileSync(nginxConfPath, "utf8");

    // HTTP 1.1 & WebSocket Upgrade
    assert.match(conf, /proxy_http_version\s+1\.1;/, "Must use HTTP 1.1");
    assert.match(conf, /proxy_set_header\s+Upgrade\s+\$http_upgrade;/, "Must pass Upgrade header");
    assert.match(conf, /proxy_set_header\s+Connection\s+\$connection_upgrade;/, "Must pass Connection header");
    assert.match(conf, /map\s+\$http_upgrade\s+\$connection_upgrade/, "Must map connection upgrade");

    // Buffer and streaming controls
    assert.match(conf, /proxy_buffering\s+off;/, "proxy_buffering must be off");
    assert.match(conf, /proxy_request_buffering\s+off;/, "proxy_request_buffering must be off");
    assert.match(conf, /proxy_cache\s+off;/, "proxy_cache must be off");
    assert.match(conf, /chunked_transfer_encoding\s+on;/, "chunked_transfer_encoding must be on");
    assert.match(conf, /add_header\s+X-Accel-Buffering\s+no;/, "Must disable downstream proxy buffering via X-Accel-Buffering: no");

    // Timeouts
    assert.match(conf, /proxy_connect_timeout\s+3s;/, "proxy_connect_timeout must be 3s");
    assert.match(conf, /proxy_read_timeout\s+86400s;/, "proxy_read_timeout must be 86400s");
    assert.match(conf, /proxy_send_timeout\s+86400s;/, "proxy_send_timeout must be 86400s");

    // Dynamic DNS resolution and variable proxy_pass
    assert.match(conf, /resolver\s+127\.0\.0\.11\s+valid=5s;/, "Must use Docker embedded DNS 127.0.0.11 with valid=5s");
    assert.match(conf, /set\s+\$node_upstream\s+http:\/\/desktop-control-plane:30300;/, "Must set $node_upstream variable to NodePort");
    assert.match(conf, /proxy_pass\s+\$node_upstream;/, "Must proxy_pass to variable $node_upstream");
  });

  it("2. start-gateway.ps1 dry-run asserts correct Docker launch parameters (network, restart, loopback, ro mount)", () => {
    assert.ok(fs.existsSync(startScriptPath), "start-gateway.ps1 must exist");

    const script = fs.readFileSync(startScriptPath, "utf8");
    assert.match(script, /"--network",\s*"kind"/, "Script must attach to kind network");
    assert.match(script, /"--restart",\s*"no"/, "Script must specify restart policy 'no'");
    assert.match(script, /127\.0\.0\.1:\$\{Port\}:3001/, "Script must bind strictly to 127.0.0.1");
    assert.match(script, /:\/etc\/nginx\/nginx\.conf:ro/, "Script must mount nginx.conf as read-only");

    // Dynamic execution if PowerShell is available in environment
    const psCmd = process.platform === "win32" ? "powershell.exe" : (fs.existsSync("/usr/bin/pwsh") ? "/usr/bin/pwsh" : null);
    if (psCmd) {
      const stdout = execFileSync(psCmd, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        startScriptPath,
        "-DryRun",
        "-Port",
        "3002"
      ], { encoding: "utf8" });

      const data = JSON.parse(stdout.trim());
      assert.equal(data.Network, "kind", "Container must attach to the kind network");
      assert.equal(data.Restart, "no", "Restart policy must be 'no'");
      assert.equal(data.Port, 3002, "Port parameter must be respected");
      assert.match(data.Bind, /^127\.0\.0\.1:3002:3001$/, "Must bind strictly to loopback 127.0.0.1");
      assert.match(data.Mount, /nginx\.conf:\/etc\/nginx\/nginx\.conf:ro$/, "Must mount nginx.conf as read-only (:ro)");
    }
  });

  it("3. stop-gateway.ps1 exists and invokes docker rm -f kind-gateway", () => {
    assert.ok(fs.existsSync(stopScriptPath), "stop-gateway.ps1 must exist");
    const script = fs.readFileSync(stopScriptPath, "utf8");
    assert.match(script, /docker\s+rm\s+-f\s+kind-gateway/, "Must remove kind-gateway container");
  });
});
