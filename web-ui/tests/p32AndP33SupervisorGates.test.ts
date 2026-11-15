import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  verifyJobCompletion,
  writeMilestoneHandoff,
  readMilestoneHandoff,
} from "../lib/subagents/finishVerificationGate";

describe("P3.2 & P3.3: Finish-verification gate & milestone handoff chunking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `p3-gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "init\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("P3.2: verifyJobCompletion rejects when gatePassed is false or artifacts/commits are missing", () => {
    const baseCommit = execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();
    const fail = verifyJobCompletion({
      workspaceRoot: tmpDir,
      expectedArtifacts: ["missing.ts"],
      gatePassed: false,
      baseCommit,
    });
    assert.equal(fail.ok, false);
    assert.ok(fail.reasons.length >= 2, "must report missing artifact, failed gate, and no new commits");

    fs.writeFileSync(path.join(tmpDir, "out.ts"), "export const x = 1;\n");
    execSync("git add . && git commit -m feat", { cwd: tmpDir, stdio: "ignore" });

    const pass = verifyJobCompletion({
      workspaceRoot: tmpDir,
      expectedArtifacts: ["out.ts"],
      gatePassed: true,
      baseCommit,
    });
    assert.equal(pass.ok, true);
    assert.equal(pass.reasons.length, 0);
  });

  it("P3.3: milestone handoff chunking banks state and restores it for the next chunk", () => {
    const handoffPath = path.join(tmpDir, ".handoff.json");
    writeMilestoneHandoff(handoffPath, {
      jobId: "job-1",
      completedMilestones: ["m1", "m2"],
      nextMilestone: "m3",
      summary: "m1 and m2 committed",
      updatedAt: new Date().toISOString(),
    });
    const loaded = readMilestoneHandoff(handoffPath);
    assert.ok(loaded);
    assert.equal(loaded.jobId, "job-1");
    assert.deepEqual(loaded.completedMilestones, ["m1", "m2"]);
    assert.equal(loaded.nextMilestone, "m3");
  });
});
