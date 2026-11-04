import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getBridgeManifest, computeBridgeSourceSha256, PROTOCOL_VERSION } from "../../host-bridge/manifest";

describe("Architecture Deletion & Provenance Conformance Suite", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const scriptPath = path.join(repoRoot, "scripts/Start-HostRunner.ps1");

  it("Test 1: asserts scripts/Start-HostRunner.ps1 does NOT exist on disk", () => {
    assert.strictEqual(
      fs.existsSync(scriptPath),
      false,
      "scripts/Start-HostRunner.ps1 must not exist on disk; compiled native daemon replaces it"
    );
  });

  it("Test 2: asserts no repo source files in scripts/, deploy/, web-ui/app/, web-ui/lib/ contain Start-HostRunner.ps1", () => {
    const searchDirs = ["scripts", "deploy", "web-ui/app", "web-ui/lib"];
    const violations: string[] = [];

    function scan(dir: string) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile()) {
          const content = fs.readFileSync(fullPath, "utf8");
          if (content.includes("Start-HostRunner.ps1")) {
            violations.push(path.relative(repoRoot, fullPath).replace(/\\/g, "/"));
          }
        }
      }
    }

    for (const relDir of searchDirs) {
      scan(path.join(repoRoot, relDir));
    }

    assert.deepStrictEqual(
      violations,
      [],
      `Found forbidden references to Start-HostRunner.ps1 in: ${violations.join(", ")}`
    );
  });

  it("Test 3: asserts C:\\AI\\ai-control\\bin\\host-runner.exe exists and is a valid compiled executable (> 50MB)", () => {
    const exePath = "C:\\AI\\ai-control\\bin\\host-runner.exe";
    assert.strictEqual(fs.existsSync(exePath), true, `Compiled executable must exist at ${exePath}`);
    const stats = fs.statSync(exePath);
    const sizeInMB = stats.size / (1024 * 1024);
    assert.ok(
      sizeInMB > 50,
      `Compiled binary at ${exePath} must be > 50MB, but got ${sizeInMB.toFixed(2)} MB`
    );
  });

  it("Test 4: asserts host-bridge/manifest.ts exports protocolVersion: 1 and deterministic SHA-256 matching manifest.json", () => {
    const hostBridgeDir = path.join(repoRoot, "host-bridge");
    const manifestJsonPath = path.join(hostBridgeDir, "manifest.json");

    assert.strictEqual(fs.existsSync(manifestJsonPath), true, "host-bridge/manifest.json must exist");
    const manifestJson = JSON.parse(fs.readFileSync(manifestJsonPath, "utf8"));

    assert.strictEqual(PROTOCOL_VERSION, 1, "PROTOCOL_VERSION must equal 1");

    const manifest = getBridgeManifest(hostBridgeDir);
    assert.strictEqual(manifest.protocolVersion, 1, "manifest.protocolVersion must equal 1");
    assert.strictEqual(
      manifest.bridgeSourceSha256,
      manifestJson.bridgeSourceSha256,
      "manifest.bridgeSourceSha256 must match manifest.json"
    );

    const computedSha = computeBridgeSourceSha256(hostBridgeDir);
    assert.strictEqual(
      computedSha,
      manifestJson.bridgeSourceSha256,
      `Deterministic SHA-256 (${computedSha}) must match manifest.json (${manifestJson.bridgeSourceSha256})`
    );
  });
});
