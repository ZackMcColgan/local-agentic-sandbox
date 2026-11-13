import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { ChatStream } from "../components/ChatStream";

// UI-007: Aborted/disconnected turns persist as status 'incomplete' with the
// marker text (app/api/chat/route.ts:469-471, :486). The transient reconcile
// banner (ChatStream.tsx:1646-1652) only exists while actively reconciling;
// once reconciliation ends the turn must still read as a DISTINCT
// recoverable-status affordance — a chip plus a retry/resume control — not
// bare prose indistinguishable from completed narration.
//
// Presentation + affordance only: the persisted marker text and the
// reconciliation behavior are untouched by this suite's contract.

const DISCONNECT_MARKER =
  "⚠️ [Turn incomplete: Stream aborted or disconnected.]";

function render(messages: any[]): string {
  return renderToString(
    React.createElement(ChatStream, {
      onTracesUpdate: () => {},
      activeModel: "qwen3.8:27b-q3_k_m",
      reasoningEffort: "medium",
      messages
    })
  );
}

describe("UI-007: incomplete turns render a distinct recoverable-status affordance", () => {
  it("renders an 'Incomplete' status chip for an incomplete assistant record", () => {
    const html = render([
      { id: "u1", role: "user", content: "Run the ui-qa sweep" },
      {
        id: "a1",
        role: "assistant",
        status: "incomplete",
        content: `${DISCONNECT_MARKER} Partial answer captured before the disconnect.`
      }
    ]);
    assert.ok(
      html.includes('data-testid="message-status-badge"'),
      "incomplete record must render a status chip"
    );
    assert.ok(html.includes("Incomplete"), "chip must carry the Incomplete label");
  });

  it("renders a retry/resume affordance so the incomplete turn can be recovered from the UI", () => {
    const html = render([
      { id: "u1", role: "user", content: "Run the ui-qa sweep" },
      {
        id: "a1",
        role: "assistant",
        status: "incomplete",
        content: `${DISCONNECT_MARKER} Partial answer captured before the disconnect.`
      }
    ]);
    assert.ok(
      html.includes('data-testid="incomplete-retry"'),
      "incomplete record must expose a retry/resume affordance (UI-007)"
    );
    assert.match(
      html,
      /<button[^>]*data-testid="incomplete-retry"/,
      "the affordance must be an interactive control, not plain text"
    );
    assert.ok(
      html.includes("Retry turn") || html.includes("Resume turn"),
      "the affordance must carry a recovery label"
    );
  });

  it("completed turns stay bare prose with no chip and no retry affordance", () => {
    const html = render([
      { id: "u1", role: "user", content: "Run the ui-qa sweep" },
      {
        id: "a2",
        role: "assistant",
        status: "completed",
        content: "Sweep finished; findings written to docs."
      }
    ]);
    assert.ok(
      !html.includes('data-testid="message-status-badge"'),
      "completed turns must not render a status chip"
    );
    assert.ok(
      !html.includes('data-testid="incomplete-retry"'),
      "completed turns must not render a retry affordance"
    );
  });

  it("keeps the persisted marker text unchanged in the rendered content", () => {
    const html = render([
      { id: "u1", role: "user", content: "Run the ui-qa sweep" },
      {
        id: "a1",
        role: "assistant",
        status: "incomplete",
        content: `${DISCONNECT_MARKER} Partial answer captured before the disconnect.`
      }
    ]);
    assert.ok(
      html.includes("Turn incomplete: Stream aborted or disconnected."),
      "the persisted marker text must survive rendering verbatim"
    );
  });
});
