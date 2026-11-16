import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Extract the first JS/MJS code block or fall back to raw output.
 * @param {string} output
 */
function extractCode(output) {
  const match = (output || "").match(/```(?:js|mjs|javascript)?\s*\n([\s\S]*?)```/i);
  return match ? match[1].trim() : (output || "").trim();
}

/**
 * Grade pr-coding output by running the hidden test suite against an isolated temp tree.
 * @param {string} output
 * @param {{ hiddenTestsPassRate?: number }} passBar
 * @param {string} repoRoot
 */
export async function gradePrCoding(output, passBar, repoRoot) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-pr-coding-"));
  try {
    const code = extractCode(output);
    fs.writeFileSync(path.join(tmpDir, "retryAfter.mjs"), code, "utf8");
    const hiddenTestSrc = path.join(repoRoot, "eval/tasks/pr-coding/hidden-tests/retryAfter.test.mjs");
    const hiddenTestDst = path.join(tmpDir, "retryAfter.test.mjs");
    fs.copyFileSync(hiddenTestSrc, hiddenTestDst);

    const res = spawnSync(process.execPath, ["retryAfter.test.mjs"], {
      cwd: tmpDir,
      encoding: "utf8",
      timeout: 15000,
    });

    const passed = res.status === 0;
    return {
      passed,
      evidence: {
        exitCode: res.status,
        stdout: (res.stdout || "").slice(0, 1000),
        stderr: (res.stderr || "").slice(0, 1000),
      },
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
