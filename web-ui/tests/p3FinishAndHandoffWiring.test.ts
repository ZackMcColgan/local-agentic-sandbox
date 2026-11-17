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

  it("stamps completed-unverified with named gap when a claimed commit SHA does not resolve through the real completion path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-unverified-"));
    try {
      const artifact = "deliverable.ts";
      fs.writeFileSync(path.join(tmpDir, artifact), "export const ok = true;\n");

      const supervisor = new OvernightSupervisor({
        checkpointDirectory: path.join(tmpDir, ".checkpoints")
      });

      const task: TaskManifest = {
        taskId: "p3-unverified-1",
        goal: "Test unverified commit stamp",
        toolchain: "node:22",
        branchName: "feat/p3-unverified",
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
        stepExecutor: async () => ({
          status: "completed",
          diff: "diff",
          modifiedFiles: [artifact]
        }),
        repoRoot: tmpDir,
        completionClaims: {
          commits: ["deadbeef00000000000000000000000000000000"],
          files: [artifact],
          gatePassed: true
        }
      } as any);

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.completionStamp, "completed-unverified");
      assert.ok(
        result.verificationGaps?.some((g) => g.kind === "commit" && g.claim === "deadbeef00000000000000000000000000000000"),
        "verificationGaps must name the unresolved commit SHA"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stamps completed with zero gaps when all claims resolve through the real completion path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-verified-"));
    try {
      const artifact = "deliverable.ts";
      fs.writeFileSync(path.join(tmpDir, artifact), "export const ok = true;\n");

      const supervisor = new OvernightSupervisor({
        checkpointDirectory: path.join(tmpDir, ".checkpoints")
      });

      const task: TaskManifest = {
        taskId: "p3-verified-1",
        goal: "Test verified stamp",
        toolchain: "node:22",
        branchName: "feat/p3-verified",
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
        stepExecutor: async () => ({
          status: "completed",
          diff: "diff",
          modifiedFiles: [artifact]
        }),
        repoRoot: tmpDir,
        completionClaims: {
          files: [artifact],
          gatePassed: true
        }
      } as any);

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.completionStamp, "completed");
      assert.deepStrictEqual(result.verificationGaps, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
