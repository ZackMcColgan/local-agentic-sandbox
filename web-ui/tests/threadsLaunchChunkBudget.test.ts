import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/threads/route";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest } from "../lib/subagents/types";
import { resolveThreadChunkBudget } from "../lib/jobChunking";
import { ThreadStore } from "../lib/threads/threadStore";

describe("Threads API — launchTask chunkBudget persistence", () => {
  it("persists chunkBudget.maxRounds when provided as nested chunkBudget", async () => {
    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task: TaskManifest) {
      return task;
    };

    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal: "Test nested chunkBudget persistence",
          chunkBudget: { maxRounds: 8 },
        }),
      });

      const res = await POST(req);
      assert.ok(res.status === 200 || res.status === 201, `Expected 200/201 but got ${res.status}`);
      const data = await res.json();
      assert.equal(data.thread?.chunkBudget?.maxRounds, 8);

      const store = new ThreadStore();
      const persisted = await store.getThread(data.thread.id);
      assert.ok(persisted, "Created thread must be persisted");
      assert.equal(persisted.chunkBudget?.maxRounds, 8);
      assert.equal(resolveThreadChunkBudget(persisted)?.maxRounds, 8);
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });

  it("persists chunkBudget.maxRounds when provided as flat maxRounds alias", async () => {
    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task: TaskManifest) {
      return task;
    };

    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal: "Test flat maxRounds alias persistence",
          maxRounds: 8,
        }),
      });

      const res = await POST(req);
      assert.ok(res.status === 200 || res.status === 201, `Expected 200/201 but got ${res.status}`);
      const data = await res.json();
      assert.equal(data.thread?.chunkBudget?.maxRounds, 8);

      const store = new ThreadStore();
      const persisted = await store.getThread(data.thread.id);
      assert.ok(persisted, "Created thread must be persisted");
      assert.equal(persisted.chunkBudget?.maxRounds, 8);
      assert.equal(resolveThreadChunkBudget(persisted)?.maxRounds, 8);
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });

  it("carries no chunkBudget when launched without a budget", async () => {
    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task: TaskManifest) {
      return task;
    };

    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal: "Test launch without chunkBudget",
        }),
      });

      const res = await POST(req);
      assert.ok(res.status === 200 || res.status === 201, `Expected 200/201 but got ${res.status}`);
      const data = await res.json();
      assert.equal(data.thread?.chunkBudget, undefined);

      const store = new ThreadStore();
      const persisted = await store.getThread(data.thread.id);
      assert.ok(persisted, "Created thread must be persisted");
      assert.equal(persisted.chunkBudget, undefined);
      assert.equal(resolveThreadChunkBudget(persisted), undefined);
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });
});
