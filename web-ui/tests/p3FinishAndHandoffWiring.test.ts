import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import type { TaskManifest } from "../lib/subagents/types";

describe("P3.2 / P3.3: Supervisor finishVerificationGate & milestoneHandoff wiring", () => {
  it("writes milestone handoff at milestone end and blocks completion if verifyJobCompletion fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-wiring-"));
    try {
      const supervisor = new OvernightSupervisor({
        checkpointDirectory: path.join(tmpDir, ".checkpoints")
      });

      const task: TaskManifest = {
        taskId: "p3-wire-1",
        goal: "Test P3.2 and P3.3 wiring",
        toolchain: "node:22",
        branchName: "feat/p3-wire",
        status: "active",
        milestones: [
          {
            id: "M1",
            title: "First milestone",
            description: "Do M1",
            acceptanceCriteria: [{ id: "AC-1", assertion: "M1 done" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          },
          {
            id: "M2",
            title: "Second milestone",
            description: "Do M2",
            acceptanceCriteria: [{ id: "AC-2", assertion: "M2 done" }],
            status: "pending",
            builderIterations: 0,
            criticRounds: 0
          }
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const result = await supervisor.executeTaskWithRecovery(task, {
        stepExecutor: async (_t, m) => ({
          status: "completed",
          diff: `diff for ${m}`,
          modifiedFiles: [`${m}.ts`]
        }),
        repoRoot: tmpDir
      });

      const handoffPath = path.join(tmpDir, ".checkpoints", `${task.taskId}.handoff.json`);
      assert.ok(fs.existsSync(handoffPath), "Milestone handoff file must be written during milestone chunking");
      assert.strictEqual(result.status, "failed", "verifyJobCompletion must block completion when verification fails");
      assert.ok(
        result.journal.some((j) => j.action?.includes("Finish verification gate blocked completion")),
        "Journal must record finish verification gate block"
      );

      // Now verify that finishVerificationGate.ts does not interpolate baseCommit into execSync
      const gateSrc = fs.readFileSync(
        path.resolve(__dirname, "../lib/subagents/finishVerificationGate.ts"),
        "utf8"
      );
      assert.ok(!gateSrc.includes("execSync(`git rev-list"), "Must not interpolate baseCommit into execSync shell string");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
