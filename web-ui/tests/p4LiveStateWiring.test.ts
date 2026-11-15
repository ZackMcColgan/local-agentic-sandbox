import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveStatus,
  buildExecutionSummary,
  formatExecutionSummaryForMorningReport,
  seedReadDedupFromHistory,
  evictPairedToolCalls,
} from "../lib/liveState";

describe("P4.1–P4.3: Live state wiring, executionSummary, ReadDedup & paired eviction", () => {
  it("P4.1: buildLiveStatus produces structured liveStatus payload", () => {
    const status = buildLiveStatus({ round: 2, phase: "tool_execution", activeTool: "search_web", tokensUsed: 1200 });
    assert.equal(status.round, 2);
    assert.equal(status.phase, "tool_execution");
    assert.equal(status.activeTool, "search_web");
    assert.equal(status.tokensUsed, 1200);
    assert.ok(status.updatedAt);
  });

  it("P4.2: buildExecutionSummary formats cleanly for Morning Report", () => {
    const summary = buildExecutionSummary({
      rounds: 3,
      toolsCalled: ["workspace_read_file", "workspace_patch_file"],
      filesModified: ["web-ui/lib/foo.ts"],
      status: "completed",
    });
    const reportLine = formatExecutionSummaryForMorningReport(summary);
    assert.ok(reportLine.includes("3 rounds"));
    assert.ok(reportLine.includes("workspace_patch_file"));
    assert.ok(reportLine.includes("web-ui/lib/foo.ts"));
  });

  it("P4.3a: seedReadDedupFromHistory extracts prior read paths from earlier turns", () => {
    const history = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc1", function: { name: "workspace_read_file", arguments: { path: "src/a.ts" } } }],
      },
      { role: "tool", tool_call_id: "tc1", name: "workspace_read_file", content: "file contents..." },
    ];
    const seeded = seedReadDedupFromHistory(history);
    assert.ok(seeded.has("src/a.ts"));
  });

  it("P4.3b: evictPairedToolCalls evicts assistant tool_calls and matching tool results together", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc_old", function: { name: "workspace_read_file", arguments: { path: "a.ts" } } }],
      },
      { role: "tool", tool_call_id: "tc_old", name: "workspace_read_file", content: "x".repeat(400) },
      { role: "assistant", content: "Done." },
    ];
    const evicted = evictPairedToolCalls(messages, 50);
    const hasOrphanTool = evicted.some((m: any) => m.role === "tool" && m.tool_call_id === "tc_old");
    const hasOrphanCall = evicted.some((m: any) => m.tool_calls?.some((tc: any) => tc.id === "tc_old"));
    assert.equal(hasOrphanTool, false, "tool result must be evicted");
    assert.equal(hasOrphanCall, false, "matching assistant tool_call must be evicted together");
  });
});
