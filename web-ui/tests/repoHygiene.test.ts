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
    const violating = lines.filter((file) => file.endsWith(".scratch") || file.endsWith(".updated"));
    assert.deepEqual(violating, [], "No tracked files should end with .scratch or .updated");
  });
});
