import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import * as LiveRunBlockModule from "../components/LiveRunBlock";
import { TaskManifest } from "../lib/subagents/types";

describe("LiveRunBlock — Deliverable Code Preview", () => {
  const sampleTaskWithDiff: TaskManifest = {
    taskId: "task-preview-1",
    goal: "Update helper function",
    status: "completed",
    toolchain: "node:22",
    branchName: "feat/helper",
    milestones: [
      {
        id: "m1",
        title: "Patch helper.ts",
        description: "Edit helper",
        acceptanceCriteria: [],
        builderIterations: 1,
        criticRounds: 1,
        status: "completed",
        plannedFiles: ["src/helper.ts"],
        diffSummary: [
          "--- a/src/helper.ts",
          "+++ b/src/helper.ts",
          "@@ -1,4 +1,5 @@",
          " export function add(a: number, b: number) {",
          "+  const sum = a + b;",
          "-  return a + b;",
          "+  return sum;",
          " }",
        ].join("\n"),
      },
    ],
    currentMilestoneIndex: 0,
    checkpoints: [],
    ambiguityFlags: [],
    journal: [],
    startedAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:01:00.000Z",
    completedAt: "2026-11-20T10:01:00.000Z",
  };

  it("1. Exports resolveDeliverableFile, buildDeliverableFileUrl, and resolveCodePreviewContent helpers", () => {
    const mod = LiveRunBlockModule as Record<string, unknown>;
    assert.strictEqual(
      typeof mod.resolveDeliverableFile,
      "function",
      "resolveDeliverableFile must be exported"
    );
    assert.strictEqual(
      typeof mod.buildDeliverableFileUrl,
      "function",
      "buildDeliverableFileUrl must be exported"
    );
    assert.strictEqual(
      typeof mod.resolveCodePreviewContent,
      "function",
      "resolveCodePreviewContent must be exported"
    );
  });

  it("2. Resolves deliverable file and builds /api/files?path=... URL matching SVG/HTML branches", () => {
    const mod = LiveRunBlockModule as any;
    const file = mod.resolveDeliverableFile(sampleTaskWithDiff);
    assert.strictEqual(file, "src/helper.ts");
    assert.strictEqual(mod.buildDeliverableFileUrl(file), "/api/files?path=src%2Fhelper.ts");
  });

  it("3. Returns actual loaded file content when available, never additions-only diff reconstruction", () => {
    const mod = LiveRunBlockModule as any;
    const realFileContent = [
      "export function add(a: number, b: number) {",
      "  const sum = a + b;",
      "  return sum;",
      "}",
    ].join("\n");

    const preview = mod.resolveCodePreviewContent("src/helper.ts", realFileContent);
    assert.strictEqual(preview, realFileContent);
  });

  it("4. Falls back to committed-file placeholder when file cannot be loaded", () => {
    const mod = LiveRunBlockModule as any;
    const fallback = mod.resolveCodePreviewContent("src/helper.ts", null);
    assert.strictEqual(fallback, "// Deliverable committed: src/helper.ts");
  });

  it("5. LiveRunBlock.tsx does not reconstruct code preview from diffSummary additions", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/LiveRunBlock.tsx"), "utf-8");
    assert.ok(
      !src.includes('l.startsWith("+") && !l.startsWith("+++")'),
      "LiveRunBlock must not reconstruct code preview by filtering diffSummary lines starting with '+'"
    );
    assert.ok(
      src.includes("buildDeliverableFileUrl") && src.includes("/api/files?path="),
      "LiveRunBlock must load deliverable code via /api/files?path=..."
    );
  });
});
