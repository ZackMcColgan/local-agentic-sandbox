import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleToolExecution } from "../../host-bridge/server";
import { checkCommandDialect } from "../../host-bridge/dialectGuard";
import { JobStore, runAsyncJob } from "../../host-bridge/jobStore";

describe("dialectGuard wiring in host-bridge/server.ts", () => {
  it("rejects bash dialect commands in host_run_powershell via handleToolExecution", async () => {
    const res = await handleToolExecution(
      "host_run_powershell",
      { command: "export FOO=bar && ls" },
      {} as any
    );
    assert.ok(res);
    assert.strictEqual(res.success, false);
    assert.match(res.error ?? "", /Shell dialect mismatch/i);
  });

  it("rejects bash dialect commands in async host_run_powershell via runAsyncJob", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobstore-dialect-"));
    try {
      const store = new JobStore(tempDir);
      const rec = store.create("host_run_powershell", { command: "export FOO=bar && ls" }, 10_000);
      await runAsyncJob(store, rec, async () => {
        throw new Error("executeOtherTool should not be called for host_run_powershell");
      });
      const settled = store.get(rec.id);
      assert.ok(settled, "expected job record to exist");
      assert.strictEqual(settled.status, "failed");
      assert.match(settled.error || "", /Shell dialect mismatch/i);
      assert.ok(typeof settled.finishedAt === "number", "expected finishedAt to be set");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns explicit noRules: true for cmd shell", () => {
    const res = checkCommandDialect("dir", "cmd");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.noRules, true);
    assert.match(res.reason || "", /No dialect rules/i);
  });
});
