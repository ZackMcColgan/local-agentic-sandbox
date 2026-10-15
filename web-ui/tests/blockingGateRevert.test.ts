import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  recordTestBaseline,
  compareAndRevertIfWorse,
  type TestSnapshot,
  type RevertResult
} from "../lib/subagents/workerPool.js";

describe("Phase 2 — Item 2: Blocking-Gate Revert Suite", () => {
  const testRepo = path.resolve(process.cwd(), "temp-test-revert-repo");

  function setupRepo(): string {
    if (fs.existsSync(testRepo)) fs.rmSync(testRepo, { recursive: true, force: true });
    fs.mkdirSync(testRepo, { recursive: true });
    execSync("git init -b main", { cwd: testRepo, stdio: "ignore" });
    execSync("git config user.name 'Revert Tester'", { cwd: testRepo, stdio: "ignore" });
    execSync("git config user.email 'tester@revert.test'", { cwd: testRepo, stdio: "ignore" });

    fs.writeFileSync(path.join(testRepo, "app.ts"), "export const value = 1;", "utf8");
    execSync("git add -A && git commit -m \"initial commit\"", { cwd: testRepo, stdio: "ignore" });
    return testRepo;
  }

  function cleanupRepo() {
    if (fs.existsSync(testRepo)) fs.rmSync(testRepo, { recursive: true, force: true });
  }

  it("Fix that improves tests does NOT trigger revert", async () => {
    setupRepo();
    try {
      const baseline: TestSnapshot = {
        passCount: 10,
        failCount: 2,
        failingTests: ["testA", "testB"],
        timestamp: new Date().toISOString()
      };

      const result = await compareAndRevertIfWorse(baseline, testRepo, undefined, ["app.ts"], {
        evaluator: async () => ({ passCount: 11, failCount: 1, failingTests: ["testB"] })
      });

      assert.equal(result.reverted, false, "Improving tests must NOT trigger revert");
      assert.equal(result.before.passed, 10);
      assert.equal(result.after.passed, 11);
      assert.equal(result.after.failed, 1);
    } finally {
      cleanupRepo();
    }
  });

  it("Fix that worsens tests DOES trigger revert and restores original files", async () => {
    setupRepo();
    try {
      const baseline: TestSnapshot = {
        passCount: 10,
        failCount: 1,
        failingTests: ["testA"],
        timestamp: new Date().toISOString()
      };

      fs.writeFileSync(path.join(testRepo, "app.ts"), "export const value = 999; // BROKEN", "utf8");

      const result = await compareAndRevertIfWorse(baseline, testRepo, undefined, ["app.ts"], {
        evaluator: async () => ({ passCount: 9, failCount: 3, failingTests: ["testA", "testB", "testC"] })
      });

      assert.equal(result.reverted, true, "Degrading tests MUST trigger revert");
      assert.ok(result.filesReverted.includes("app.ts"));
      assert.ok(result.logMessage?.includes("10→9 pass, 1→3 fail"));

      const restoredContent = fs.readFileSync(path.join(testRepo, "app.ts"), "utf8");
      assert.equal(restoredContent, "export const value = 1;");
    } finally {
      cleanupRepo();
    }
  });

  it("Revert does not touch committed files (only uncommitted)", async () => {
    setupRepo();
    try {
      fs.writeFileSync(path.join(testRepo, "stable.ts"), "export const STABLE = true;", "utf8");
      execSync("git add -A && git commit -m \"committed feature\"", { cwd: testRepo, stdio: "ignore" });

      const baseline: TestSnapshot = {
        passCount: 20,
        failCount: 0,
        failingTests: [],
        timestamp: new Date().toISOString()
      };

      fs.writeFileSync(path.join(testRepo, "experiment.ts"), "throw new Error('fail');", "utf8");

      const result = await compareAndRevertIfWorse(baseline, testRepo, undefined, ["experiment.ts"], {
        evaluator: async () => ({ passCount: 18, failCount: 2, failingTests: ["t1", "t2"] })
      });

      assert.equal(result.reverted, true);
      assert.equal(fs.readFileSync(path.join(testRepo, "stable.ts"), "utf8"), "export const STABLE = true;");
      assert.equal(fs.existsSync(path.join(testRepo, "experiment.ts")), false);
    } finally {
      cleanupRepo();
    }
  });

  it("Revert log contains before/after counts", async () => {
    setupRepo();
    try {
      const baseline: TestSnapshot = {
        passCount: 25,
        failCount: 1,
        failingTests: ["err1"],
        timestamp: new Date().toISOString()
      };

      const result = await compareAndRevertIfWorse(baseline, testRepo, undefined, ["app.ts"], {
        evaluator: async () => ({ passCount: 23, failCount: 3, failingTests: ["err1", "err2", "err3"] })
      });

      assert.equal(result.reverted, true);
      assert.ok(result.logMessage?.includes("25→23 pass, 1→3 fail"));
      assert.ok(result.reason?.includes("degraded test suite"));
    } finally {
      cleanupRepo();
    }
  });
});
