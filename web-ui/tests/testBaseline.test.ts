import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordTestBaseline } from "../lib/subagents/workerPool.js";

describe("subagents/testBaseline characterization", () => {
  it("delegates directly to options.evaluator when provided", async () => {
    const snapshot = await recordTestBaseline(undefined, undefined, {
      evaluator: async () => ({
        passCount: 14,
        failCount: 2,
        failingTests: ["suiteA", "suiteB"],
        timestamp: "2026-11-21T00:00:00.000Z",
      }),
    });

    assert.equal(snapshot.passCount, 14);
    assert.equal(snapshot.failCount, 2);
    assert.deepEqual(snapshot.failingTests, ["suiteA", "suiteB"]);
    assert.equal(snapshot.timestamp, "2026-11-21T00:00:00.000Z");
  });

  it("parses pass and fail counts from command stdout", async () => {
    const snapshot = await recordTestBaseline(
      process.cwd(),
      `node -e "console.log('12 passing, 3 failing')"`
    );

    assert.equal(snapshot.passCount, 12);
    assert.equal(snapshot.failCount, 3);
    assert.deepEqual(snapshot.failingTests, []);
    assert.ok(Date.parse(snapshot.timestamp) > 0);
  });
});
