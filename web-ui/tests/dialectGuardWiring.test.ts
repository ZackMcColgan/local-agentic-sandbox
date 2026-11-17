import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleToolExecution } from "../../host-bridge/server";
import { checkCommandDialect } from "../../host-bridge/dialectGuard";

describe("dialectGuard wiring in host-bridge/server.ts", () => {
  it("rejects bash dialect commands in host_run_powershell via handleToolExecution", async () => {
    const res = await handleToolExecution(
      "host_run_powershell",
      { command: "export FOO=bar && ls" },
      {} as any
    );
    assert.strictEqual(res.success, false);
    assert.match(res.error, /Shell dialect mismatch/i);
  });

  it("returns explicit noRules: true for cmd shell", () => {
    const res = checkCommandDialect("dir", "cmd");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.noRules, true);
    assert.match(res.reason || "", /No dialect rules/i);
  });
});
