import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintHostCommand } from "../lib/commandDialectGuard";
import { COMMAND_DIALECT_TRAPS } from "../lib/commandDialectTraps";

describe("command-dialect-guard", () => {
  it("keeps traps in a single data array", () => {
    assert.ok(Array.isArray(COMMAND_DIALECT_TRAPS));
    assert.ok(COMMAND_DIALECT_TRAPS.length >= 3);
  });

  it("rewrites PowerShell && and || chaining and records the rule id in traceNotes", () => {
    const res = lintHostCommand("git status && npm test");
    assert.equal(res.rejected, false);
    assert.equal(res.rewritten, true);
    assert.equal(res.command, "git status ; npm test");
    assert.ok(res.ruleIds.includes("ps-chain-and"));
    assert.ok(res.traceNotes.some((n) => n.includes("ps-chain-and")));
  });

  it("rejects interactive-prompt commands with a corrective hint and rule id", () => {
    const res = lintHostCommand("git add -p");
    assert.equal(res.rejected, true);
    assert.ok(res.ruleIds.includes("interactive-git-patch"));
    assert.ok(res.hint && res.hint.length > 0);
  });

  it("surfaces standing prohibitions early at lint time", () => {
    const res = lintHostCommand("git push --force origin main");
    assert.equal(res.rejected, true);
    assert.ok(res.ruleIds.includes("prohibition-force-push"));
    assert.ok(res.hint && res.hint.length > 0);
  });

  it("passes clean commands byte-identical with no rewrite and no trace noise", () => {
    const clean = "git status -sb";
    const res = lintHostCommand(clean);
    assert.equal(res.rejected, false);
    assert.equal(res.rewritten, false);
    assert.equal(res.command, clean);
    assert.deepEqual(res.ruleIds, []);
    assert.deepEqual(res.traceNotes, []);
  });
});
