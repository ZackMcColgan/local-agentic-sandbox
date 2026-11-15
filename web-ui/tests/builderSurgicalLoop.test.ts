import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuilderWorker } from "../lib/subagents/workerPool";

describe("B-6: BuilderWorker surgical patch loop", () => {
  it("drives executeMilestoneWork on an existing file and applies a surgical diff leaving untouched regions byte-identical", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-surgical-"));
    try {
      const targetRel = "src/math.ts";
      const fullPath = path.join(tmpDir, targetRel);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      const original = [
        "// Untouched header comment",
        "export function helperA(): string {",
        '  return "untouched-A";',
        "}",
        "",
        "export function targetB(): number {",
        "  return 1;",
        "}",
        "",
        "export function helperC(): string {",
        '  return "untouched-C";',
        "}",
        ""
      ].join("\r\n");
      fs.writeFileSync(fullPath, original, "utf8");

      let capturedPrompt = "";
      const worker = new BuilderWorker({
        workspaceRoot: tmpDir,
        generate: async ({ prompt }) => {
          capturedPrompt = prompt;
          return {
            text: JSON.stringify({
              patches: [{ search: "  return 1;", replace: "  return 42;" }]
            })
          };
        }
      });

      const result = await worker.executeMilestoneWork(
        {
          id: "m1",
          title: "Update targetB",
          description: "Change targetB to return 42",
          acceptanceCriteria: [{ id: "ac1", assertion: "targetB returns 42" }],
          targetFiles: [targetRel]
        } as any,
        { repoRoot: tmpDir, targetFile: targetRel }
      );

      assert.match(capturedPrompt, /patches/i, "Prompt for existing file must ask for surgical patches");
      assert.doesNotMatch(
        capturedPrompt,
        /generate the exact, complete, production-grade file content/i,
        "Prompt for existing file must not ask for complete file rewrite"
      );

      const onDisk = fs.readFileSync(fullPath, "utf8");
      const expected = original.replace("  return 1;", "  return 42;");
      assert.strictEqual(onDisk, expected, "On-disk file must be a surgical diff with untouched CRLF regions byte-identical");
      assert.ok(result.diff.includes("-  return 1;"));
      assert.ok(result.diff.includes("+  return 42;"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
