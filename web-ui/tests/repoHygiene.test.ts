import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

describe("Sprint 4 — Repository Hygiene & Root Clutter Suite", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  it("LICENSE exists in repo root, is non-empty, and contains 'MIT License' and 'Zack McColgan'", () => {
    const licensePath = path.join(repoRoot, "LICENSE");
    assert.ok(fs.existsSync(licensePath), "LICENSE file must exist in repo root");
    const content = fs.readFileSync(licensePath, "utf8");
    assert.ok(content.length > 50, "LICENSE file must be non-empty");
    assert.ok(content.includes("MIT License"), "LICENSE must be standard MIT License");
    assert.ok(content.includes("Zack McColgan"), "LICENSE must reference Zack McColgan");
  });

  it(".opencode-remote-session.json, script.py, and triage-report.md do NOT exist in monorepo root", () => {
    const forbidden = [".opencode-remote-session.json", "script.py", "triage-report.md"];
    for (const f of forbidden) {
      const p = path.join(repoRoot, f);
      assert.equal(fs.existsSync(p), false, `Root file ${f} must be removed from repo root`);
    }
  });

  it(".gitignore contains .opencode-remote-session.json", () => {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    assert.ok(fs.existsSync(gitignorePath), ".gitignore must exist");
    const content = fs.readFileSync(gitignorePath, "utf8");
    assert.ok(
      content.includes(".opencode-remote-session.json"),
      ".gitignore must contain .opencode-remote-session.json"
    );
  });

  it("no tracked files in git ls-files end with .scratch or .updated", () => {
    const output = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" });
    const lines = output.split(/\r?\n/).filter(Boolean);
    const violating = lines.filter(
      (file) => file.endsWith(".scratch") || file.endsWith(".updated")
    );
    assert.deepEqual(violating, [], "No tracked files should end with .scratch or .updated");
  });

  it("settings memory hygiene: git ls-files returns ZERO paths ending in operator-memory.json", () => {
    const output = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" });
    const lines = output.split(/\r?\n/).filter(Boolean);
    const violating = lines.filter((file) => file.endsWith("operator-memory.json"));
    assert.deepEqual(violating, [], "No tracked files should end with operator-memory.json");
  });

  it("brand hygiene: no antigravity references in UI components, configs, or docs, and version is 2.0.0", () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(rootPkg.version, "2.0.0", "Root package.json version must be 2.0.0");
    const webUiPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "web-ui", "package.json"), "utf8")
    );
    assert.equal(
      webUiPkg.version,
      rootPkg.version,
      "web-ui package.json version must match root package.json version (single version source)"
    );

    const targets: string[] = [];
    // UI components
    const compDir = path.join(repoRoot, "web-ui/components");
    if (fs.existsSync(compDir)) {
      for (const f of fs.readdirSync(compDir)) {
        if (f.endsWith(".tsx") || f.endsWith(".ts")) targets.push(path.join(compDir, f));
      }
    }
    // Docs & configs
    const docFiles = ["README.md", "ARCHITECTURE.md"];
    for (const d of docFiles) {
      const p = path.join(repoRoot, d);
      if (fs.existsSync(p)) targets.push(p);
    }
    const docsDir = path.join(repoRoot, "docs");
    if (fs.existsSync(docsDir)) {
      for (const f of fs.readdirSync(docsDir)) {
        if (f.endsWith(".md")) targets.push(path.join(docsDir, f));
      }
    }

    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of targets) {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, idx) => {
        if (/antigravity/i.test(lineText)) {
          violations.push({
            file: path.relative(repoRoot, file),
            line: idx + 1,
            text: lineText.trim(),
          });
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      `Found antigravity references in UI/docs:\n${JSON.stringify(violations, null, 2)}`
    );
  });

  // Board item #57: personal names, local workstation paths, and banned vendor
  // terms must not appear in tracked runtime code, metadata, eval artifacts,
  // deploy manifests, docs, scripts, or test descriptions. Files that are
  // detector pattern lists or intentional detection fixtures are allowlisted.
  it("content hygiene: no personal names, local host user paths, or banned vendor terms in tracked runtime/metadata/eval/docs/test files", () => {
    const tracked = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);

    const scopePrefixes = [
      "web-ui/lib/",
      "web-ui/app/",
      "web-ui/components/",
      "web-ui/tests/",
      "web-ui/scripts/",
      "host-bridge/",
      "eval/",
      "deploy/",
      "docs/",
      "scripts/",
    ];
    const scopeExact = ["README.md", "ARCHITECTURE.md", "package.json", "web-ui/package.json"];

    // Allowlisted: this detector itself, reviewer-gate pattern lists and their
    // detection fixtures, board-UI forbidden lists, repoMap's vendor-config
    // ignore-directory entries, and path-confinement/fixture tests that
    // intentionally exercise drive-letter host paths.
    const allowlist = [
      "web-ui/tests/repoHygiene.test.ts",
      "web-ui/lib/board/reviewerGate.ts",
      "web-ui/tests/reviewerGate.test.ts",
      "web-ui/tests/boardUi.test.ts",
      "web-ui/lib/subagents/repoMap.ts",
      "web-ui/tests/activityTimeline.test.ts",
      "web-ui/tests/boardDrainExecution.test.ts",
      "web-ui/tests/flowMonitor.test.ts",
      "web-ui/tests/hostFileRestriction.test.ts",
      "web-ui/tests/uiuxAuditFixes.test.ts",
      "web-ui/tests/conversationCompaction.test.ts",
    ];

    const targets = tracked.filter((file) => {
      if (allowlist.includes(file)) return false;
      if (file.endsWith(".lock") || file.endsWith(".lock.json")) return false;
      if (file.startsWith("host-bridge/dist/")) return false;
      return scopePrefixes.some((p) => file.startsWith(p)) || scopeExact.includes(file);
    });

    const personalPattern = /\bzack\b|\bmccolgan\b|zackm\b/i;
    // Local workstation user-home paths (any drive letter + Users/Documents/AppData).
    const hostPathPattern = /[A-Za-z]:[\\/](?:Users|Documents|AppData)[\\/]/i;
    const vendorPattern =
      /\b(claude|anthropic|chatgpt|gemini|copilot|windsurf|antigravity|codex|openai)\b/i;
    // The ban targets vendor branding, not the OpenAI wire-format compatibility
    // contract that the engine layer legitimately references.
    const vendorExceptionPattern =
      /openai[-\s]?compatible|normalizeOpenAIMessages|mock-openai-server|openai-server/i;
    // Repo-origin identity URLs (CI badge, Helm chart home, PR-link fixtures)
    // legitimately carry the GitHub owner slug; they are repo identity, not
    // runtime personal-name leakage.
    const repoIdentityExceptionPattern = /github\.com\/ZackMcColgan\/local-agentic-sandbox/i;

    const violations: { file: string; line: number; kind: string; text: string }[] = [];
    for (const file of targets) {
      const abs = path.join(repoRoot, file);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, idx) => {
        const kinds: string[] = [];
        if (personalPattern.test(lineText) && !repoIdentityExceptionPattern.test(lineText)) {
          kinds.push("personal-name");
        }
        if (hostPathPattern.test(lineText)) kinds.push("local-host-path");
        if (vendorPattern.test(lineText) && !vendorExceptionPattern.test(lineText)) {
          kinds.push("banned-vendor-term");
        }
        if (kinds.length > 0) {
          violations.push({
            file,
            line: idx + 1,
            kind: kinds.join(","),
            text: lineText.trim().slice(0, 120),
          });
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      `Found hygiene violations:\n${JSON.stringify(violations, null, 2)}`
    );
  });
});
