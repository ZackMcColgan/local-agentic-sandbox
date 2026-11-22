import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Sprint 5 — Documentation Integrity & Hiring Manager Polish Suite", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  const docsToCheck = [
    "README.md",
    "ARCHITECTURE.md",
    "docs/KUBERNETES_DEPLOYMENT.md",
    "docs/AI_GOVERNANCE.md",
    "deploy/modelfiles/README.md",
  ];

  it("extracts all relative Markdown links and asserts every referenced file exists on disk", () => {
    const linkRegex =
      /\[([^\]]+)\]\(((\.{1,2}\/|docs\/|web-ui\/|mcp-server\/|deploy\/)[^)#\s]+)(?:#[^)]*)?\)/g;

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

  it("ARCHITECTURE.md does NOT reference nonexistent paths AUTONOMOUS_SPEC.md or modelDispatcher.ts", () => {
    const archPath = path.join(repoRoot, "ARCHITECTURE.md");
    const content = fs.readFileSync(archPath, "utf8");
    assert.equal(
      content.includes("AUTONOMOUS_SPEC.md"),
      false,
      "ARCHITECTURE.md must not reference nonexistent AUTONOMOUS_SPEC.md"
    );
    assert.equal(
      content.includes("modelDispatcher.ts"),
      false,
      "ARCHITECTURE.md must not reference nonexistent modelDispatcher.ts"
    );
  });

  it("README.md and deploy/modelfiles/README.md reference swift-15-27b-mtp as active model", () => {
    const targetFiles = ["README.md", "deploy/modelfiles/README.md"];

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
      "mcp-server/src/tools/workspaceTools.ts",
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

  it("docs/AI_GOVERNANCE.md exists, aligns with NIST AI RMF & OWASP Agentic Top 10, links to enforcement files, and is linked in README", () => {
    const govPath = path.join(repoRoot, "docs/AI_GOVERNANCE.md");
    assert.ok(fs.existsSync(govPath), "docs/AI_GOVERNANCE.md must exist on disk");

    const govContent = fs.readFileSync(govPath, "utf8");
    assert.ok(govContent.length > 500, "docs/AI_GOVERNANCE.md must be non-empty and substantive");

    // Assert NIST AI RMF core functions
    assert.ok(govContent.includes("NIST AI RMF"), "Must reference NIST AI RMF");
    assert.ok(govContent.includes("GOVERN"), "Must reference NIST GOVERN function");
    assert.ok(govContent.includes("MAP"), "Must reference NIST MAP function");
    assert.ok(govContent.includes("MEASURE"), "Must reference NIST MEASURE function");
    assert.ok(govContent.includes("MANAGE"), "Must reference NIST MANAGE function");

    // Assert OWASP Top 10 for Agentic Applications
    assert.ok(govContent.includes("OWASP"), "Must reference OWASP framework");
    assert.ok(govContent.includes("ASI01"), "Must reference OWASP ASI01 (Agent Goal Hijack)");
    assert.ok(
      govContent.includes("ASI02"),
      "Must reference OWASP ASI02 (Tool Misuse & Exploitation)"
    );
    assert.ok(
      govContent.includes("ASI03"),
      "Must reference OWASP ASI03 (Identity & Privilege Abuse)"
    );

    // Assert relative links to enforcement source files
    const requiredEnforcementFiles = [
      "deploy/k8s/mcp-runner.yaml",
      "deploy/k8s/network-policies.yaml",
      "web-ui/lib/subagents/workerPool.ts",
      "web-ui/lib/subagents/supervisor.ts",
      "web-ui/lib/subagents/skillGate.ts",
      "web-ui/lib/ledger/runLedger.ts",
      "web-ui/lib/git/workerGitOps.ts",
      "web-ui/lib/deploy/selfDeploy.ts",
      "web-ui/lib/memory/profile.ts",
      "mcp-server/src/tools/attestation.ts",
    ];

    for (const relFile of requiredEnforcementFiles) {
      assert.ok(
        govContent.includes(relFile),
        `docs/AI_GOVERNANCE.md must contain reference/link to enforcement file: ${relFile}`
      );
      assert.ok(
        fs.existsSync(path.join(repoRoot, relFile)),
        `Enforcement file must exist on disk: ${relFile}`
      );
    }

    // Assert README.md links to docs/AI_GOVERNANCE.md
    const readmeContent = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    assert.ok(
      readmeContent.includes("docs/AI_GOVERNANCE.md") ||
        readmeContent.includes("./docs/AI_GOVERNANCE.md"),
      "README.md must link to ./docs/AI_GOVERNANCE.md"
    );
  });

  it("README.md and ARCHITECTURE.md state the live Playwright census (284 tests, 13 spec files, 4 projects)", () => {
    for (const rel of ["README.md", "ARCHITECTURE.md"]) {
      const content = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      assert.ok(
        !/272 tests|12 spec files|12 Playwright/.test(content),
        `${rel} must not claim the stale 272-test / 12-spec Playwright census`
      );
      assert.ok(
        /284 tests across 13 spec files and 4 projects/.test(content),
        `${rel} must state the live Playwright census: 284 tests across 13 spec files and 4 projects`
      );
    }
  });

  it("README.md states the live unit-test census (1,930 tests across 283 files)", () => {
    const content = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    assert.ok(
      !/1,647|1,681|1,677|1,227/.test(content),
      "README.md must not claim stale unit-test counts (1,647 / 1,681 / 1,677 / 1,227+)"
    );
    assert.ok(
      /1,930 unit and contract tests across 283 files/.test(content),
      "README.md must state the live unit census: 1,930 tests across 283 files"
    );
  });

  it("README.md documents host-port egress instead of claiming zero external internet egress", () => {
    const content = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    assert.ok(
      !content.includes("zero external internet egress"),
      "README.md must not claim 'zero external internet egress': deploy/k8s/network-policies.yaml leaves host ports 8080/11434/11435/8765 open without to: selectors"
    );
    assert.ok(
      /8080/.test(content) && /8765/.test(content),
      "README.md must accurately document the host-port egress (Strata :8080, llama/ollama :11434/:11435, host bridge :8765)"
    );
  });

  it("ARCHITECTURE.md does NOT reference nonexistent lib/agentEngine.ts", () => {
    const content = fs.readFileSync(path.join(repoRoot, "ARCHITECTURE.md"), "utf8");
    assert.ok(
      !content.includes("agentEngine.ts"),
      "ARCHITECTURE.md must not reference nonexistent web-ui/lib/agentEngine.ts"
    );
  });

  it("docs/AI_GOVERNANCE.md attestation snippet does not require() the ESM attestation module", () => {
    const content = fs.readFileSync(path.join(repoRoot, "docs/AI_GOVERNANCE.md"), "utf8");
    assert.ok(
      !content.includes("require('./dist/tools/attestation.js')"),
      "AI_GOVERNANCE.md must not require() dist/tools/attestation.js: mcp-server is ESM ('type': 'module') and attestation.ts exports only registerAttestation(mcp)"
    );
    assert.ok(
      content.includes("verify_container_provenance"),
      "AI_GOVERNANCE.md must reference the attestation MCP tool name"
    );
  });

  it("scripts/lan-bridge.js warning cites a README section that exists", () => {
    const bridge = fs.readFileSync(path.join(repoRoot, "scripts/lan-bridge.js"), "utf8");
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const cited = bridge.match(/See README\.?md "?([^"]+)"? section/);
    assert.ok(cited, "lan-bridge.js must cite a README section");
    assert.ok(
      readme.includes(cited[1]),
      `README.md must contain the section "${cited[1]}" cited by scripts/lan-bridge.js`
    );
  });
});
