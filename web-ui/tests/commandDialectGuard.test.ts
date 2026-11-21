import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintHostCommand } from "../lib/commandDialectGuard";
import { COMMAND_DIALECT_TRAPS } from "../lib/commandDialectTraps";
import { executeHostTool } from "../lib/hostMode";

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

  it("preserves && and || inside double and single quotes byte-identical", () => {
    const doubleQuoted = 'echo "a && b"';
    const resDouble = lintHostCommand(doubleQuoted);
    assert.equal(resDouble.rejected, false);
    assert.equal(resDouble.rewritten, false);
    assert.equal(resDouble.command, doubleQuoted);
    assert.deepEqual(resDouble.ruleIds, []);
    assert.deepEqual(resDouble.traceNotes, []);

    const singleQuoted = "echo 'a || b'";
    const resSingle = lintHostCommand(singleQuoted);
    assert.equal(resSingle.rejected, false);
    assert.equal(resSingle.rewritten, false);
    assert.equal(resSingle.command, singleQuoted);
    assert.deepEqual(resSingle.ruleIds, []);
    assert.deepEqual(resSingle.traceNotes, []);
  });

  it("rewrites unquoted chains while preserving quoted && and || literals", () => {
    const cmd = `echo "a && b" && echo 'c || d'`;
    const res = lintHostCommand(cmd);
    assert.equal(res.rejected, false);
    assert.equal(res.rewritten, true);
    assert.equal(res.command, `echo "a && b" ; echo 'c || d'`);
    assert.deepEqual(res.ruleIds, ["ps-chain-and"]);
    assert.ok(res.traceNotes.some((n) => n.includes("ps-chain-and")));
  });

  it("surfaces dialectGuard ruleIds and traceNotes in executeHostTool result on && rewrite", async () => {
    const origFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ ok: true, stdout: "done" }),
      } as any;
    }) as any;
    try {
      const result = await executeHostTool("host_run_powershell", {
        command: "echo a && echo b",
      });
      assert.equal(capturedBody.args.command, "echo a ; echo b");
      assert.ok(result.dialectGuard, "expected dialectGuard on rewritten tool result");
      assert.ok(result.dialectGuard.ruleIds.includes("ps-chain-and"));
      assert.ok(
        result.dialectGuard.traceNotes.some((n: string) => n.includes("ps-chain-and"))
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("surfaces dialectGuard ruleIds and traceNotes in executeHostTool result on || rewrite", async () => {
    const origFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ ok: true, stdout: "done" }),
      } as any;
    }) as any;
    try {
      const result = await executeHostTool("host_run_powershell", {
        command: "echo a || echo b",
      });
      assert.equal(capturedBody.args.command, "echo a ; echo b");
      assert.ok(result.dialectGuard, "expected dialectGuard on rewritten tool result");
      assert.ok(result.dialectGuard.ruleIds.includes("ps-chain-or"));
      assert.ok(
        result.dialectGuard.traceNotes.some((n: string) => n.includes("ps-chain-or"))
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
