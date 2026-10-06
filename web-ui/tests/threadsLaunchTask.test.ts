import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Regression test: POST /api/threads with action "launchTask" must actually
// start the supervisor execution, not just create the manifest.
// Bug found 2026-10-06: tasks were created and planned but executeTaskWithRecovery
// was never called, so no workers ever spawned.

describe("Threads API — launchTask triggers supervisor execution", () => {
  it("POST /api/threads with action launchTask calls executeTaskWithRecovery", async () => {
    // We verify the route module wires execution by checking the source.
    // A full integration test would require Ollama + worker pool.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const routePath = path.join(process.cwd(), "app/api/threads/route.ts");
    const source = fs.readFileSync(routePath, "utf-8");

    // The route must kick off execution after creating the manifest
    assert.ok(
      source.includes("executeTaskWithRecovery"),
      "threads/route.ts must call executeTaskWithRecovery to start workers"
    );

    // It must provide a step executor (fail-closed: no executor = throw)
    assert.ok(
      source.includes("createProductionStepExecutor") || source.includes("stepExecutor"),
      "threads/route.ts must provide a stepExecutor for fail-closed execution"
    );
  });

  it("launchTask does not await execution (fire-and-forget for fast API response)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const routePath = path.join(process.cwd(), "app/api/threads/route.ts");
    const source = fs.readFileSync(routePath, "utf-8");

    // Should NOT be "await supervisor.executeTaskWithRecovery" — that would block the response
    // Should be fire-and-forget with .catch for error logging
    const hasFireAndForget =
      source.includes(".executeTaskWithRecovery(") &&
      !source.match(/await\s+supervisor\.executeTaskWithRecovery/);

    assert.ok(
      hasFireAndForget,
      "executeTaskWithRecovery should be fire-and-forget, not awaited"
    );
  });
});
