import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildVerificationAdapters } from "../lib/subagents/supervisor";

describe("buildVerificationAdapters characterization", () => {
  const tempDirs: string[] = [];

  function makeTempGitRepo(): { dir: string; headSha: string; branch: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-adapters-test-"));
    tempDirs.push(dir);
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "README.md"), "# Verification Test Repo\n", "utf8");
    execSync("git add README.md", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', { cwd: dir, stdio: "ignore" });
    const headSha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const branch = execSync("git branch --show-current", { cwd: dir, encoding: "utf8" }).trim();
    return { dir, headSha, branch };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveCommit returns true for a real commit SHA and false for an unknown SHA", async () => {
    const { dir, headSha } = makeTempGitRepo();
    const adapters = buildVerificationAdapters(dir);

    assert.equal(await adapters.resolveCommit(headSha), true);
    assert.equal(await adapters.resolveCommit("deadbeef00000000000000000000000000000000"), false);
  });

  it("branchExists returns true for the checked-out branch and false for a nonexistent branch", async () => {
    const { dir, branch } = makeTempGitRepo();
    const adapters = buildVerificationAdapters(dir);

    assert.ok(adapters.branchExists);
    assert.equal(await adapters.branchExists(branch), true);
    assert.equal(await adapters.branchExists("does-not-exist-branch"), false);
  });

  it("fileExists resolves both relative and absolute paths accurately", async () => {
    const { dir } = makeTempGitRepo();
    const adapters = buildVerificationAdapters(dir);

    assert.ok(adapters.fileExists);
    assert.equal(await adapters.fileExists("README.md"), true);
    assert.equal(await adapters.fileExists(path.join(dir, "README.md")), true);
    assert.equal(await adapters.fileExists("missing-relative.ts"), false);
    assert.equal(await adapters.fileExists(path.join(dir, "missing-absolute.ts")), false);
  });

  it("checkPr returns { exists: false, state: null } without throwing when no GitHub remote/PR resolves", async () => {
    const { dir } = makeTempGitRepo();
    const adapters = buildVerificationAdapters(dir);

    const res = await adapters.checkPr(999999);
    assert.deepEqual(res, { exists: false, state: null });
  });
});
