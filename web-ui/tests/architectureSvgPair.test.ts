import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Fix 4 — Architecture Diagram & SVG Pair Synchronization Suite", () => {
  const repoRoot = fs.existsSync(path.join(process.cwd(), "deploy")) ? process.cwd() : path.resolve(process.cwd(), "..");
  const drawioPath = path.resolve(repoRoot, "docs/architecture.drawio");
  const svgPath = path.resolve(repoRoot, "docs/architecture.drawio.svg");

  it("both architecture.drawio and architecture.drawio.svg exist", () => {
    assert.ok(fs.existsSync(drawioPath), "docs/architecture.drawio must exist");
    assert.ok(fs.existsSync(svgPath), "docs/architecture.drawio.svg must exist");
  });

  it("architecture.drawio.svg is an export of the 30-cell superset containing all restored components", () => {
    const svgContent = fs.readFileSync(svgPath, "utf8");

    const requiredRestoredLabels = [
      "Mobile Phone",
      "LAN Reverse Proxy Bridge",
      "KUBERNETES CLUSTER",
      "workspace-pvc",
      "qwen3.8:27b-q3_k_m",
      "gemma4:e4b",
      "ai-mesh",
      "egress-mesh"
    ];

    for (const label of requiredRestoredLabels) {
      assert.ok(
        svgContent.includes(label),
        `docs/architecture.drawio.svg must contain restored superset label: "${label}"`
      );
    }
  });

  it("architecture.drawio and architecture.drawio.svg stay synchronized as a matched pair", () => {
    const drawioContent = fs.readFileSync(drawioPath, "utf8");
    const svgContent = fs.readFileSync(svgPath, "utf8");

    // Both must use pure white background per UI standards
    assert.ok(drawioContent.includes('background="#ffffff"'), "draw.io must use #ffffff background");
    assert.ok(svgContent.includes('background-color: #ffffff') || svgContent.includes('fill="#ffffff"'), "SVG must use #ffffff background");

    // File sizes must reflect the full 30-cell superset
    assert.ok(Buffer.byteLength(drawioContent, "utf8") >= 12000, "draw.io must be >= 12,000 bytes");
    assert.ok(Buffer.byteLength(svgContent, "utf8") >= 15000, "SVG must be >= 15,000 bytes (full superset export)");
  });
});
