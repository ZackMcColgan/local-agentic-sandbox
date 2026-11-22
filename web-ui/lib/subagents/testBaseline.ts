import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import type { TestSnapshot, RevertResult } from "./types";
import { releaseCurrentSlotForWait } from "../slotScheduler";

/**
 * Guardrail 2 (Item 2): Blocking-Gate Revert
 * Records test suite baseline before builder attempt
 */
export async function recordTestBaseline(
  repoRoot?: string,
  testCommand?: string,
  options?: { evaluator?: () => Promise<TestSnapshot> }
): Promise<TestSnapshot> {
  if (options?.evaluator) {
    return await options.evaluator();
  }

  const root = repoRoot || process.cwd();
  const cmd = testCommand || "npm test";
  let stdout = "";
  let passCount = 0;
  let failCount = 0;
  const failingTests: string[] = [];

  stdout = await releaseCurrentSlotForWait(() => {
    try {
      return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    } catch (err: unknown) {
      const e = err as { stdout?: string; message?: string };
      return e.stdout || e.message || "";
    }
  });

  const passMatch = stdout.match(/(\d+)\s+pass(?:ing|ed)/i);
  if (passMatch) passCount = parseInt(passMatch[1], 10);
  const failMatch = stdout.match(/(\d+)\s+fail(?:ing|ed)/i);
  if (failMatch) failCount = parseInt(failMatch[1], 10);

  return {
    passCount,
    failCount,
    failingTests,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Guardrail 2 (Item 2): Compares test results after builder attempt and reverts uncommitted changes if worse
 */
export async function compareAndRevertIfWorse(
  baseline: TestSnapshot,
  repoRoot?: string,
  testCommand?: string,
  modifiedFiles?: string[],
  options?: {
    evaluator?: () => Promise<{ passCount: number; failCount: number; failingTests?: string[] }>;
  }
): Promise<RevertResult> {
  const root = repoRoot || process.cwd();
  let afterCounts: { passCount: number; failCount: number; failingTests?: string[] };

  if (options?.evaluator) {
    afterCounts = await options.evaluator();
  } else {
    const afterSnapshot = await recordTestBaseline(root, testCommand);
    afterCounts = {
      passCount: afterSnapshot.passCount,
      failCount: afterSnapshot.failCount,
      failingTests: afterSnapshot.failingTests,
    };
  }

  const isWorse =
    afterCounts.failCount > baseline.failCount || afterCounts.passCount < baseline.passCount;

  if (isWorse) {
    const filesToRevert = modifiedFiles && modifiedFiles.length > 0 ? modifiedFiles : [];
    if (filesToRevert.length > 0) {
      for (const file of filesToRevert) {
        try {
          execFileSync("git", ["checkout", "--", file], { cwd: root, stdio: "ignore" });
        } catch {
          const full = path.resolve(root, file);
          if (fs.existsSync(full)) fs.unlinkSync(full);
        }
      }
    } else {
      try {
        execSync("git checkout -- .", { cwd: root, stdio: "ignore" });
        execSync("git clean -fd", { cwd: root, stdio: "ignore" });
      } catch {}
    }

    const logMsg = `Reverted: ${baseline.passCount}→${afterCounts.passCount} pass, ${baseline.failCount}→${afterCounts.failCount} fail`;
    console.warn(`[BLOCKING-GATE REVERT] ${logMsg}. Reason: Fix attempt degraded test suite.`);

    return {
      reverted: true,
      filesReverted: filesToRevert,
      before: { passed: baseline.passCount, failed: baseline.failCount },
      after: { passed: afterCounts.passCount, failed: afterCounts.failCount },
      reason: "Fix attempt degraded test suite",
      logMessage: logMsg,
    };
  }

  return {
    reverted: false,
    filesReverted: [],
    before: { passed: baseline.passCount, failed: baseline.failCount },
    after: { passed: afterCounts.passCount, failed: afterCounts.failCount },
  };
}
