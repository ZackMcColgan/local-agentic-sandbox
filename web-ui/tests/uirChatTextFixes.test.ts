import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { ChatStream } from "../components/ChatStream";
import { ThreadsSidebar } from "../components/ThreadsSidebar";

// UI Refresh slice 1 — chat text fixes (UI-016, UI-012, UI-014).
// Locked design (FINAL-DESIGN board, Nov 12, 2026):
// - UI-016: user message text wraps — long unbreakable tokens must not clip
//   or overflow the bubble (break-words + min-w-0 on the bubble chain).
// - UI-012: sidebar thread titles wrap at word boundaries instead of
//   hard-clipping mid-word (break-words on the card title).
// - UI-014: long user briefs (>320 chars or >6 lines) collapse behind a
//   "Show full brief" toggle; short messages never collapse.

function renderChat(messages: { id: string; role: "user" | "assistant"; content: string }[]) {
  return renderToString(
    React.createElement(ChatStream, {
      onTracesUpdate: () => {},
      activeModel: "qwen3.8-flash-next-gyro-gyro-s",
      reasoningEffort: "low",
      messages
    })
  );
}

function classSegment(html: string, marker: string, span = 220): string {
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `expected rendered html to contain marker: ${marker}`);
  return html.slice(idx, idx + span);
}

describe("UI Refresh slice 1 — chat text fixes", () => {
  it("UI-016: user prose wraps long unbreakable tokens (break-words + min-w-0 chain)", () => {
    const token = "x".repeat(140);
    const html = renderChat([
      { id: "u1", role: "user", content: `see ${token} end` }
    ]);
    assert.ok(html.includes(token), "long token must render");
    const prose = classSegment(html, "prose dark:prose-invert");
    assert.ok(
      prose.includes("break-words"),
      "user prose container must carry break-words so unbreakable tokens wrap"
    );
    const bubble = classSegment(html, "max-w-[88%]", 120);
    assert.ok(
      bubble.includes("min-w-0"),
      "user bubble column must carry min-w-0 so the bubble can shrink and wrap"
    );
  });

  it("UI-012: sidebar thread titles wrap instead of clipping mid-word", () => {
    const longTitle = "trace-rows-need-accessible-names-and-live-rendering-proof";
    const html = renderToString(
      React.createElement(ThreadsSidebar, {
        threads: [
          {
            id: "thread-1",
            title: longTitle,
            status: "active" as const,
            model: "qwen3.8-flash-next-gyro-gyro-s",
            reasoningEffort: "low" as const,
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ],
        selectedThreadId: "thread-1",
        activeNavView: "sessions",
        onSelectThread: () => {},
        onNewThread: () => {},
        onNavigate: () => {},
        onOpenDrawer: () => {}
      })
    );
    assert.ok(html.includes(longTitle), "full title text must be present");
    const title = classSegment(html, "leading-snug");
    assert.ok(
      title.includes("break-words"),
      "thread card title must carry break-words so long titles wrap at boundaries"
    );
  });

  it("UI-014: a long user brief collapses behind a Show full brief toggle", () => {
    const brief = ("Build the thing. " + "Detail line with enough words to matter. ".repeat(4) + "\n").repeat(4);
    assert.ok(brief.length > 320);
    const html = renderChat([{ id: "u2", role: "user", content: brief }]);
    assert.ok(
      html.includes("Show full brief"),
      "long brief must render a Show full brief toggle"
    );
    assert.ok(
      html.includes("max-h-["),
      "collapsed brief must clamp its height with a max-h class"
    );
    assert.ok(
      html.includes('data-testid="brief-collapse-toggle"'),
      "collapse toggle must carry the brief-collapse-toggle test id"
    );
  });

  it("UI-014: a short user message never collapses", () => {
    const html = renderChat([{ id: "u3", role: "user", content: "Ship it please." }]);
    assert.ok(!html.includes("Show full brief"), "short message must not offer a collapse toggle");
    assert.ok(!html.includes('data-testid="brief-collapse-toggle"'));
  });

  it("UI-014: a brief over 6 lines collapses even under 320 chars", () => {
    const brief = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
    assert.ok(brief.length < 320);
    const html = renderChat([{ id: "u4", role: "user", content: brief }]);
    assert.ok(html.includes("Show full brief"), "7-line brief must collapse");
  });
});
