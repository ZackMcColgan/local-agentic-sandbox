import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { convertDrawioToSvg, sanitizeSvg, isDrawioXml } from "../lib/svgUtils";
import { createCriticWorker, getResolvedGitSha } from "../lib/subagents/workerPool";
import { Milestone } from "../lib/subagents/types";

describe("Sprint 4 — The Dogfood Run: drawio to SVG Toolchain Acceptance", () => {
  const repoRoot = fs.existsSync(path.resolve(process.cwd(), "docs/architecture.drawio"))
    ? process.cwd()
    : path.resolve(process.cwd(), "..");

  const drawioPath = path.resolve(repoRoot, "docs/architecture.drawio");
  const svgPath = path.resolve(repoRoot, "docs/architecture.svg");

  it("Verification 1: docs/architecture.drawio exists, is non-empty, and is valid XML", () => {
    assert.ok(fs.existsSync(drawioPath), `Expected ${drawioPath} to exist`);
    const content = fs.readFileSync(drawioPath, "utf8");
    assert.ok(content.length > 5000, `Expected content length > 5000 bytes, got ${content.length}`);
    assert.ok(isDrawioXml(content), "Content must be recognized as valid Draw.io XML");
    assert.ok(content.includes("<mxfile"), "Must contain <mxfile opening tag");
    assert.ok(content.includes("</mxfile>"), "Must contain </mxfile> closing tag");
    assert.ok(content.includes("<mxGraphModel"), "Must contain <mxGraphModel");
    assert.ok(content.includes('background="#ffffff"'), "Must specify white canvas background #ffffff");
  });

  it("Verification 2: Toolchain converts docs/architecture.drawio to docs/architecture.svg (delete-and-regenerate)", () => {
    // 1. Delete docs/architecture.svg if it exists to test pure generation
    if (fs.existsSync(svgPath)) {
      fs.unlinkSync(svgPath);
    }
    assert.equal(fs.existsSync(svgPath), false, "docs/architecture.svg must be deleted prior to regeneration test");

    // 2. Invoke the toolchain script
    const toolchainScript = path.resolve(repoRoot, "scripts/drawio-to-svg.ts");
    assert.ok(fs.existsSync(toolchainScript), `Toolchain script must exist at ${toolchainScript}`);

    const tsxPath = path.resolve(repoRoot, "web-ui/node_modules/tsx/dist/cli.mjs");
    const output = execSync(`node "${tsxPath}" "${toolchainScript}" "${drawioPath}" "${svgPath}"`, {
      encoding: "utf8",
      cwd: repoRoot
    });

    assert.ok(output.includes("SUCCESS") || output.includes("Generated"), `Toolchain must report success: ${output}`);

    // 3. Check generated SVG file
    assert.ok(fs.existsSync(svgPath), "docs/architecture.svg must be created by toolchain");
    const svgContent = fs.readFileSync(svgPath, "utf8");
    assert.ok(svgContent.length > 5000, `SVG file must be substantive (>5000 bytes), got ${svgContent.length}`);
    assert.ok(svgContent.startsWith("<svg") || svgContent.includes("<svg"), "Must contain opening <svg tag");
    assert.ok(svgContent.includes("</svg>"), "Must contain closing </svg> tag");
    assert.ok(svgContent.includes("viewBox="), "Must contain responsive viewBox attribute");

    // 4. Verify architectural component labels are preserved
    const requiredLabels = [
      "CLIENT & INGRESS LAYER",
      "KUBERNETES CLUSTER",
      "HOST INFERENCE BOUNDARY",
      "web-ui Orchestrator Pod",
      "mcp-runner Tool Boundary",
      "browser-mcp Scraper Pod",
      "builder-tier Toolchain Sandbox",
      "qdrant-service: Qdrant Vector",
      "ollama-service"
    ];

    for (const label of requiredLabels) {
      assert.ok(
        svgContent.includes(label) || svgContent.includes(label.replace(/&/g, "&amp;")),
        `Generated SVG must contain architectural label '${label}'`
      );
    }
  });

  it("Verification 3: Real Git SHA resolution and no fabricated commit hashes", () => {
    const realSha = getResolvedGitSha(repoRoot);
    assert.ok(/^[0-9a-f]{40}$/i.test(realSha), `Must be a genuine 40-character git SHA, got ${realSha}`);
    assert.notEqual(realSha, "d7c84cb12a5e4b6c8d0e2f4a6b8c0d2e4f6a8b0c", "Must not be the fake fallback hash");

    // Verifies against git log
    const gitHead = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    assert.equal(realSha.toLowerCase(), gitHead.toLowerCase(), "getResolvedGitSha must match actual git rev-parse HEAD");
  });

  it("Verification 4: Critic evaluated diffs without fail-open (abstained when model unreachable, approves conforming)", async () => {
    const milestone: Milestone = {
      id: "M-dogfood",
      title: "Architecture Diagram Conversion Toolchain",
      description: "Convert docs/architecture.drawio to docs/architecture.svg with white background and clean vector output",
      acceptanceCriteria: [
        { id: "AC-1", assertion: "docs/architecture.svg generated and valid vector graphic" },
        { id: "AC-2", assertion: "background is pure white #ffffff" }
      ],
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0
    };

    // 1. Critic with unreachable endpoint must ABSTAIN, never fail-open
    const deadCritic = createCriticWorker({ ollamaUrl: "http://127.0.0.1:54321" });
    const deadReview = await deadCritic.evaluateMilestoneDiff(milestone, {
      diff: "+ <svg background=\"#ffffff\"></svg>",
      filesChanged: ["docs/architecture.svg"]
    });

    assert.equal(deadReview.approved, false, "Critic must NEVER approve when model endpoint is unreachable");
    assert.equal(deadReview.abstained, true, "Critic review must record abstained: true");
    assert.ok(deadReview.feedback.some(f => f.includes("abstaining")), "Feedback must explain abstention");

    // 2. Injected generator approves clean conforming diff
    const approvingCritic = createCriticWorker({
      generate: async () => ({
        text: JSON.stringify({ approved: true, feedback: [], analysis: "All criteria satisfied" }),
        model: "injected-critic",
        loadDurationMs: 0,
        totalDurationMs: 10
      })
    });
    const conformingDiff = `--- a/docs/architecture.svg\n+++ b/docs/architecture.svg\n@@ -0,0 +1,5 @@\n+<svg viewBox="0 0 1600 1100" xmlns="http://www.w3.org/2000/svg">\n+<rect fill="#ffffff" width="100%" height="100%"/>\n+</svg>`;
    const validReview = await approvingCritic.evaluateMilestoneDiff(milestone, {
      diff: conformingDiff,
      filesChanged: ["docs/architecture.svg"]
    });
    assert.equal(validReview.approved, true, "Critic must approve clean conforming diff");

    // 3. Critic with rejected review must report approved: false
    const rejectingCritic = createCriticWorker({
      generate: async () => ({
        text: JSON.stringify({ approved: false, feedback: ["Background color missing"], analysis: "Criteria violated" }),
        model: "injected-critic",
        loadDurationMs: 0,
        totalDurationMs: 10
      })
    });
    const rejectedReview = await rejectingCritic.evaluateMilestoneDiff(milestone, {
      diff: conformingDiff,
      filesChanged: ["docs/architecture.svg"]
    });
    assert.equal(rejectedReview.approved, false, "Critic must report approved: false on rejection");
    assert.ok(rejectedReview.feedback.length > 0, "Critic must surface rejection feedback");
  });
});
