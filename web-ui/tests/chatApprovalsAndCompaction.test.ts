import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostApprovalsPanel } from "../components/chat/approvals";
import { CompactionPill } from "../components/chat/compactionPill";
import type { UiHostApproval } from "../components/ChatStream";

describe("chat/approvals and chat/compactionPill", () => {
  it("HostApprovalsPanel renders pending approval card with Approve/Deny buttons", () => {
    const approvals: UiHostApproval[] = [
      {
        id: "app-1",
        tool: "host_exec",
        args: { command: "rm -rf /tmp/test", cwd: "/workspace", recursive: true },
        riskReason: "Destructive command",
        status: "pending",
        expiresAt: Date.now() + 60_000,
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(HostApprovalsPanel, { approvals, onDecision: () => {} })
    );
    assert.ok(html.includes('data-testid="host-approval-card"'));
    assert.ok(html.includes('data-testid="host-approve-btn"'));
    assert.ok(html.includes('data-testid="host-deny-btn"'));
    assert.ok(html.includes("Security Approval Required"));
    assert.ok(html.includes("rm -rf /tmp/test"));
  });

  it("HostApprovalsPanel renders receipt for executed/denied approvals", () => {
    const approvals: UiHostApproval[] = [
      {
        id: "app-2",
        tool: "host_write",
        args: { path: "foo.txt" },
        riskReason: "Write file",
        status: "executed",
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(HostApprovalsPanel, { approvals, onDecision: () => {} })
    );
    assert.ok(html.includes('data-testid="host-approval-receipt"'));
    assert.ok(html.includes("Executed"));
    assert.ok(html.includes("foo.txt"));
  });

  it("CompactionPill renders token counts and caps action chips at 3 with overflow", () => {
    const html = renderToStaticMarkup(
      React.createElement(CompactionPill, {
        tokensBeforeCompaction: 120000,
        tokensAfterCompaction: 45000,
        compactionActions: [
          "compaction",
          "elide_tool_outputs",
          "drop_old_turns",
          "truncate_oversize",
        ],
      })
    );
    assert.ok(html.includes('data-testid="compaction-turn-note"'));
    assert.ok(html.includes("History compacted:"));
    assert.ok(html.includes("Elide tool outputs"));
    assert.ok(html.includes('data-testid="compaction-action-overflow"'));
    assert.ok(html.includes("+1 more"));
  });
});
