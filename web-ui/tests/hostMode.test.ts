import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDestructiveHostAction,
  createPendingApproval,
  getPendingApprovals,
  resolvePendingApproval,
  HOST_TOOLS_DEFINITIONS
} from "../lib/hostMode";

describe("Host Mode & Destructive Action Gate Suite", () => {
  it("defines all 5 standard host tools with valid schemas", () => {
    assert.equal(HOST_TOOLS_DEFINITIONS.length, 5);
    const names = HOST_TOOLS_DEFINITIONS.map((t) => t.function.name);
    assert.ok(names.includes("host_run_powershell"));
    assert.ok(names.includes("host_read_file"));
    assert.ok(names.includes("host_write_file"));
    assert.ok(names.includes("host_list_dir"));
    assert.ok(names.includes("host_delete_path"));
  });

  it("detects destructive PowerShell patterns and file deletion", () => {
    const delPath = isDestructiveHostAction("host_delete_path", { path: "C:\\Windows\\temp" });
    assert.equal(delPath.isDestructive, true);

    const safePs = isDestructiveHostAction("host_run_powershell", { command: "Get-Process | Select-Object -First 5" });
    assert.equal(safePs.isDestructive, false);

    const rmPs = isDestructiveHostAction("host_run_powershell", { command: "Remove-Item -Recurse -Force ./build" });
    assert.equal(rmPs.isDestructive, true);

    const taskkillPs = isDestructiveHostAction("host_run_powershell", { command: "taskkill /F /IM node.exe" });
    assert.equal(taskkillPs.isDestructive, true);
  });

  it("manages pending approvals in memory without persistence", () => {
    const req = createPendingApproval(
      "thread-test-1",
      "host_delete_path",
      { path: "D:\\AI\\temp_junk.txt" },
      "Permanent deletion of host path"
    );

    assert.equal(req.status, "pending");
    const pending = getPendingApprovals("thread-test-1");
    assert.ok(pending.some((p) => p.id === req.id));

    const resolved = resolvePendingApproval(req.id, "approved");
    assert.equal(resolved?.status, "approved");
  });
});
