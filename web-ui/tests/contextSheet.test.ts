import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToString } from "react-dom/server";
import { ContextSheet } from "../components/ContextSheet";
import { deriveContextSegments, countCompactions } from "../lib/contextSegments";

// Board #138 (owner directive, Nov 25 2026): the header context meter pill is
// a TAP TARGET on every surface. Tapping opens one Context sheet (bottom sheet
// on mobile, centered dialog on desktop) that shows used/budget with percent
// and free tokens, the 85K auto-compact trigger tick, segment bars derived
// from the existing per-message/per-trace estimates, the last round's actual
// prompt tokens, compaction count, and the last compaction card. Actions:
// Compact history now (existing POST /api/threads/<id>/compact handler) and
// Restore full history (existing restoreCompaction action) only when a
// compaction boundary exists. Compact is disabled while a turn streams, with
// the reason shown.

const componentsDir = path.resolve(__dirname, "../components");

describe("#138 header meter is a tappable button on all surfaces", () => {
  const file = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf-8");

  it("the context-meter-pill renders as a <button> with a 44px touch target", () => {
    const pillIdx = file.indexOf('data-testid="context-meter-pill"');
    assert.ok(pillIdx > 0, "meter pill must exist");
    const window = file.slice(Math.max(0, pillIdx - 400), pillIdx + 400);
    assert.ok(window.includes("<button"), "meter pill must be a button element");
    assert.ok(window.includes("min-h-[44px]"), "meter pill must have a 44px touch target");
    assert.ok(
      window.includes('aria-label="Open context details"') ||
        window.includes('aria-label="Open context sheet"'),
      "meter pill button must be labeled"
    );
  });

  it("tapping the pill opens the context sheet and the sheet is mounted in ChatStream", () => {
    assert.ok(
      file.includes("setShowContextSheet(true)"),
      "pill tap must open the context sheet state"
    );
    assert.ok(file.includes("<ContextSheet"), "ChatStream must mount ContextSheet");
    assert.ok(
      file.includes("onCompact={handleManualCompact}"),
      "sheet Compact action must reuse the existing compact handler"
    );
    assert.ok(
      file.includes("onRestore={handleRestoreCompaction}"),
      "sheet Restore action must reuse the existing restoreCompaction handler"
    );
    assert.ok(
      file.includes("isStreaming={isTurnLive}"),
      "sheet must know when a turn is streaming"
    );
    // Desktop overflow menu item stays as is.
    assert.ok(
      file.includes('"Compact history now"') || file.includes("Compact history now"),
      "overflow menu Compact history now item must remain"
    );
  });
});

describe("#138 context sheet content from state", () => {
  function renderSheet(props: React.ComponentProps<typeof ContextSheet>) {
    return renderToString(React.createElement(ContextSheet, props));
  }

  const base = {
    open: true,
    onClose: () => {},
    usedTokens: 72400,
    budgetTokens: 100000,
    triggerTokens: 85000,
    segments: { toolResults: 40000, conversation: 28000, system: 4400 },
    lastRoundPromptTokens: 72400,
    compactionCount: 2,
    compaction: null,
    isStreaming: false,
    isCompacting: false,
    onCompact: () => {},
    onRestore: () => {},
  };

  it("shows used / budget with percent and free tokens", () => {
    const html = renderSheet(base);
    assert.ok(html.includes('data-testid="context-sheet"'), "sheet must render");
    assert.ok(html.includes("72.4K"), "used readout must show 72.4K");
    assert.ok(html.includes("100K"), "budget readout must show 100K");
    assert.ok(html.includes("72%"), "percent must show 72%");
    assert.ok(html.includes("27.6K"), "free tokens must show 27.6K");
  });

  it("shows the 85K trigger marker in rose and segment rows for tools/conversation/system", () => {
    const html = renderSheet(base);
    assert.ok(
      html.includes('data-testid="context-sheet-tick"') && html.includes("#f87171"),
      "bar must carry the rose 85K trigger tick"
    );
    assert.ok(html.includes("85K"), "tick must be labeled 85K");
    assert.ok(html.includes("Tool results"), "segment row: tool results");
    assert.ok(html.includes("Conversation"), "segment row: conversation");
    assert.ok(html.includes("System"), "segment row: system");
    assert.ok(html.includes("40.0K"), "tool-results segment value");
    assert.ok(html.includes("28.0K"), "conversation segment value");
    assert.ok(html.includes("4.4K"), "system segment value");
  });

  it("shows chips for the last round's prompt tokens and compaction count", () => {
    const html = renderSheet(base);
    assert.ok(html.includes("Last round"), "chip: last round");
    assert.ok(html.includes("72.4K"), "last-round chip value");
    assert.ok(html.includes("Compactions"), "chip: compactions");
    assert.ok(html.includes(">2<") || html.includes("2"), "compaction count value");
  });

  it("shows the last-compaction card only when a compaction boundary exists", () => {
    const without = renderSheet(base);
    assert.ok(!without.includes("Last compaction"), "no boundary means no card");

    const withBoundary = renderSheet({
      ...base,
      compaction: {
        summary: "DIGEST: pinned facts and open threads.",
        compactedAt: "2026-11-25T10:00:00Z",
        tokensBefore: 91000,
        tokensAfter: 38000,
      },
    });
    assert.ok(withBoundary.includes("Last compaction"), "boundary means card");
    assert.ok(withBoundary.includes("91000"), "card shows tokens before");
    assert.ok(withBoundary.includes("38000"), "card shows tokens after");
    assert.ok(withBoundary.includes("DIGEST: pinned facts"), "card shows retained digest");
  });

  it("Restore full history is hidden without a boundary and present with one", () => {
    const without = renderSheet(base);
    assert.ok(!without.includes("Restore full history"), "restore hidden with no boundary");

    const withBoundary = renderSheet({
      ...base,
      compaction: {
        summary: "DIGEST",
        compactedAt: "2026-11-25T10:00:00Z",
        tokensBefore: 91000,
        tokensAfter: 38000,
      },
    });
    assert.ok(
      withBoundary.includes("Restore full history") &&
        withBoundary.includes('data-testid="context-sheet-restore"'),
      "restore present when a boundary exists"
    );
  });

  it("Compact history now is disabled while a turn streams, with the reason shown", () => {
    const html = renderSheet({ ...base, isStreaming: true });
    assert.ok(html.includes('data-testid="context-sheet-compact"'), "compact button must exist");
    assert.ok(html.includes("disabled"), "compact must be disabled while streaming");
    assert.ok(
      html.includes("A turn is streaming"),
      "disabled reason must be shown while streaming"
    );
  });

  it("Compact reflects the compacting state", () => {
    const html = renderSheet({ ...base, isCompacting: true });
    assert.ok(html.includes("Compacting history..."), "compacting label while in flight");
  });

  it("design locks: pure black canvas, emerald accent, rose only for the tick", () => {
    const html = renderSheet(base);
    assert.ok(html.includes("bg-black"), "canvas must be pure #000000");
    assert.ok(html.includes("#10b981"), "emerald must be the accent");
    assert.ok(!html.includes("bg-rose"), "rose must not fill anything (tick only)");
    assert.ok(html.includes("min-h-[44px]"), "actions must be 44px touch targets");
  });
});

describe("#138 segment derivation from existing estimates", () => {
  it("splits tool-result, conversation, and system tokens from messages and traces", () => {
    const messages = [
      { id: "s1", role: "system", content: "You are an engine on a local platform." },
      { id: "u1", role: "user", content: "Fix the meter pill so it is tappable on mobile too." },
      {
        id: "a1",
        role: "assistant",
        content: "Patched the header pill into a button and mounted the sheet component.",
        traces: [
          {
            tool: "workspace_read_file",
            args: {},
            result: "file contents ".repeat(400),
            durationMs: 5,
            timestamp: "now",
          },
        ],
      },
    ];
    const seg = deriveContextSegments(messages as never, undefined);
    assert.ok(seg.system > 0, "system segment must count system messages");
    assert.ok(seg.conversation > seg.system, "conversation segment must count user+assistant text");
    assert.ok(seg.toolResults > 0, "tool-results segment must count trace result payloads");
    assert.ok(seg.toolResults > seg.system, "the big trace result must land in tool results");
  });

  it("counts compactions from per-message records", () => {
    const messages = [
      { id: "a1", role: "assistant", content: "x", compactedThisTurn: true },
      {
        id: "a2",
        role: "assistant",
        content: "y",
        tokenEconomics: { rounds: 3, promptTokens: 10, outputTokens: 5, compactions: 2 },
      },
      { id: "u1", role: "user", content: "z" },
    ];
    assert.equal(countCompactions(messages as never), 3);
    assert.equal(countCompactions([]), 0);
  });
});
