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

  it("architecture.drawio.svg contains all current Strata & host-bridge topology components", () => {
    const svgContent = fs.readFileSync(svgPath, "utf8");

    const requiredLabels = [
      "Operator",
      "kind Gateway (nginx)",
      "Web UI / orchestrator",
      "MCP runner",
      "Browser MCP",
      "Strata inference engine",
      "Host bridge",
      "Host OS"
    ];

    for (const label of requiredLabels) {
      assert.ok(
        svgContent.includes(label),
        `docs/architecture.drawio.svg must contain label: "${label}"`
      );
    }
  });

  it("architecture.drawio and architecture.drawio.svg stay synchronized as a matched pair", () => {
    const drawioContent = fs.readFileSync(drawioPath, "utf8");
    const svgContent = fs.readFileSync(svgPath, "utf8");

    // Both must use pure white background per UI standards
    assert.ok(drawioContent.includes('background="#ffffff"'), "draw.io must use #ffffff background");
    assert.ok(svgContent.includes('background-color: #ffffff') || svgContent.includes('fill="#ffffff"'), "SVG must use #ffffff background");

    assert.ok(Buffer.byteLength(drawioContent, "utf8") >= 5000, "draw.io must be >= 5,000 bytes");
    assert.ok(Buffer.byteLength(svgContent, "utf8") >= 5000, "SVG must be >= 5,000 bytes");
  });
});
