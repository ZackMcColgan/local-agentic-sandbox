import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Sprint 5 — Documentation Integrity & Hiring Manager Polish Suite", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  const docsToCheck = [
    "README.md",
    "ARCHITECTURE.md",
    "MEMORY.md",
    "docs/FIRST_OVERNIGHT_TASK.md",
    "docs/KUBERNETES_DEPLOYMENT.md",
    "docs/FLYWHEEL_SPIKE.md",
    "deploy/modelfiles/README.md"
  ];

  it("extracts all relative Markdown links and asserts every referenced file exists on disk", () => {
    const linkRegex = /\[([^\]]+)\]\(((\.{1,2}\/|docs\/|web-ui\/|mcp-server\/|deploy\/)[^)#\s]+)(?:#[^)]*)?\)/g;

    for (const relDoc of docsToCheck) {
      const fullDocPath = path.join(repoRoot, relDoc);
      if (!fs.existsSync(fullDocPath)) continue;

      const content = fs.readFileSync(fullDocPath, "utf8");
      const docDir = path.dirname(fullDocPath);

      let match: RegExpExecArray | null;
      while ((match = linkRegex.exec(content)) !== null) {
        const rawTarget = match[2];
        // Resolve relative to either the document directory or the repo root
        const candidate1 = path.resolve(docDir, rawTarget);
        const candidate2 = path.resolve(repoRoot, rawTarget);
        const exists = fs.existsSync(candidate1) || fs.existsSync(candidate2);
        assert.ok(
          exists,
          `In ${relDoc}: referenced link target "${rawTarget}" must exist on disk (checked ${candidate1} and ${candidate2})`
        );
      }
    }
  });

  it("ARCHITECTURE.md does NOT reference nonexistent paths ANTIGRAVITY_AUTONOMOUS_SPEC.md or modelDispatcher.ts", () => {
    const archPath = path.join(repoRoot, "ARCHITECTURE.md");
    const content = fs.readFileSync(archPath, "utf8");
    assert.equal(
      content.includes("ANTIGRAVITY_AUTONOMOUS_SPEC.md"),
      false,
      "ARCHITECTURE.md must not reference nonexistent ANTIGRAVITY_AUTONOMOUS_SPEC.md"
    );
    assert.equal(
      content.includes("modelDispatcher.ts"),
      false,
      "ARCHITECTURE.md must not reference nonexistent modelDispatcher.ts"
    );
  });

  it("README.md, docs/FIRST_OVERNIGHT_TASK.md, and deploy/modelfiles/README.md reference swift-15-27b-mtp as active model", () => {
    const targetFiles = [
      "README.md",
      "docs/FIRST_OVERNIGHT_TASK.md",
      "deploy/modelfiles/README.md"
    ];

    for (const relFile of targetFiles) {
      const fullPath = path.join(repoRoot, relFile);
      const content = fs.readFileSync(fullPath, "utf8");
      assert.ok(
        content.includes("swift-15-27b-mtp"),
        `${relFile} must reference active model swift-15-27b-mtp`
      );
      assert.equal(
        content.includes("swift-27b-mtp"),
        false,
        `${relFile} must not reference retired model swift-27b-mtp`
      );
    }
  });

  it("README.md contains quick-navigation 'Key Engineering Proofs' section with valid relative links", () => {
    const readmePath = path.join(repoRoot, "README.md");
    const content = fs.readFileSync(readmePath, "utf8");

    assert.ok(
      content.includes("Key Engineering Proofs"),
      "README.md must contain 'Key Engineering Proofs' section"
    );

    const requiredProofs = [
      "web-ui/lib/subagents/supervisor.ts",
      "web-ui/lib/subagents/workerPool.ts",
      "web-ui/lib/subagents/llmClient.ts",
      "web-ui/lib/ledger/runLedger.ts",
      "web-ui/lib/git/workerGitOps.ts",
      "web-ui/lib/deploy/selfDeploy.ts",
      "mcp-server/src/tools/workspaceTools.ts"
    ];

    for (const proof of requiredProofs) {
      assert.ok(
        content.includes(proof),
        `README.md must link to required engineering proof: ${proof}`
      );
      assert.ok(
        fs.existsSync(path.join(repoRoot, proof)),
        `Proof file must exist on disk: ${proof}`
      );
    }
  });
});
