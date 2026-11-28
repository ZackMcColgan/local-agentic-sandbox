import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToString } from "react-dom/server";
import { ContextSheet } from "../components/ContextSheet";
import {
  deriveContextSegments,
  countCompactions,
  fitSegmentsToTotal,
} from "../lib/contextSegments";
import * as contextSegmentsMod from "../lib/contextSegments";

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

describe("#138 follow-ups (UI-109/UI-110): fresh-chat coherence and compact feedback", () => {
  function renderSheet(props: React.ComponentProps<typeof ContextSheet>) {
    return renderToString(React.createElement(ContextSheet, props));
  }

  const baseFresh = {
    open: true,
    onClose: () => {},
    usedTokens: 1900,
    budgetTokens: 100000,
    triggerTokens: 85000,
    segments: { toolResults: 0, conversation: 0, system: 0 },
    lastRoundPromptTokens: 0,
    compactionCount: 0,
    compaction: null,
    isStreaming: false,
    isCompacting: false,
    onCompact: () => {},
    onRestore: () => {},
  };

  it("UI-109: the unaccounted baseline lands in System so the breakdown sums to the total", () => {
    const html = renderSheet(baseFresh);
    const sysIdx = html.indexOf("System");
    assert.ok(sysIdx > 0, "system row must render");
    assert.ok(
      html.slice(sysIdx, sysIdx + 400).includes("1.9K"),
      "system row must carry the residual (total minus raw segments)"
    );
  });

  it("UI-109: the Last round chip is hidden until a round exists", () => {
    const html = renderSheet(baseFresh);
    assert.ok(!html.includes("Last round"), "no last-round chip on a fresh chat");
  });

  it("UI-110: a successful compact shows the before -> after verdict in the sheet", () => {
    const html = renderSheet({
      ...baseFresh,
      usedTokens: 12100,
      lastRoundPromptTokens: 12100,
      compactResult: { ok: true, tokensBefore: 31400, tokensAfter: 12100 },
    });
    assert.ok(html.includes("context-sheet-compact-result"), "result line must render");
    assert.ok(html.includes("Compacted:"), "success verdict label");
    assert.ok(html.includes("31.4K"), "tokens before");
    assert.ok(html.includes("12.1K"), "tokens after");
  });

  it("UI-110: a failed compact shows the error in the sheet, not only the console", () => {
    const html = renderSheet({
      ...baseFresh,
      compactResult: { ok: false, error: "Nothing to compact yet" },
    });
    assert.ok(html.includes("context-sheet-compact-result"), "result line must render");
    assert.ok(html.includes("Nothing to compact yet"), "error text must be visible");
  });

  it("UI-110: no result line before the first compact run", () => {
    const html = renderSheet(baseFresh);
    assert.ok(!html.includes("context-sheet-compact-result"), "no verdict before any run");
  });

  it("Fix 1: a noop compact result renders as a neutral noop, never as emerald Compacted", () => {
    const html = renderSheet({
      ...baseFresh,
      compactResult: {
        ok: true,
        noop: true,
        reason: "already_compacted",
        tokensBefore: 1200,
        tokensAfter: 1200,
      },
    });
    assert.ok(html.includes("context-sheet-compact-result"), "result line must render");
    assert.ok(!html.includes("Compacted:"), "noop must NEVER render Compacted: X -> Y");
    const resultIdx = html.indexOf("context-sheet-compact-result");
    const resultSnippet = html.slice(resultIdx, resultIdx + 220);
    assert.ok(
      !resultSnippet.includes("text-emerald") && !resultSnippet.includes("#10b981"),
      "noop must NOT use emerald success styling"
    );
    assert.ok(
      resultSnippet.toLowerCase().includes("nothing to compact") ||
        resultSnippet.toLowerCase().includes("already compacted"),
      "noop must explain that no compaction occurred"
    );
  });

  it("Fix 1: ChatStream surfaces noop from runManualCompaction instead of reporting success", () => {
    const file = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf-8");
    const runIdx = file.indexOf("const runManualCompaction");
    assert.ok(runIdx > 0, "runManualCompaction must exist");
    const runWindow = file.slice(runIdx, runIdx + 1600);
    assert.ok(
      runWindow.includes("data.noop"),
      "runManualCompaction must inspect data.noop from the compact endpoint"
    );
    const slashIdx = file.indexOf("if (isCompactCommand(prompt))");
    assert.ok(slashIdx > 0, "/compact branch must exist");
    const slashWindow = file.slice(slashIdx, slashIdx + 1200);
    assert.ok(
      slashWindow.includes("result.noop"),
      "/compact handler must branch on result.noop so noops never render Compacted history"
    );
  });
});

describe("fitSegmentsToTotal: the breakdown always sums to the displayed total", () => {
  it("under-count (fresh chat): residual lands in System", () => {
    const fitted = fitSegmentsToTotal({ toolResults: 0, conversation: 0, system: 0 }, 1900);
    assert.equal(fitted.system, 1900);
    assert.equal(fitted.toolResults + fitted.conversation + fitted.system, 1900);
  });

  it("exact match: segments pass through unchanged", () => {
    const seg = { toolResults: 40000, conversation: 28000, system: 4400 };
    assert.deepEqual(fitSegmentsToTotal(seg, 72400), seg);
  });

  it("over-count (long thread): proportional scale-down, exact sum", () => {
    const fitted = fitSegmentsToTotal({ toolResults: 50100, conversation: 1400, system: 0 }, 31400);
    assert.equal(fitted.toolResults + fitted.conversation + fitted.system, 31400);
    assert.ok(fitted.toolResults < 50100, "tool results scale down below the raw size");
    assert.ok(fitted.toolResults > 30000, "the largest segment keeps its dominance");
  });

  it("zero total: segments pass through (nothing to fit to)", () => {
    const seg = { toolResults: 10, conversation: 5, system: 1 };
    assert.deepEqual(fitSegmentsToTotal(seg, 0), seg);
  });
});

describe("Wave 1B Compaction Truth regressions (Fixes 2-5)", () => {
  it("Fix 2: countCompactions does not double-count when a message has both compactedThisTurn and tokenEconomics.compactions", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        content: "done",
        compactedThisTurn: true,
        tokenEconomics: { rounds: 4, promptTokens: 90000, outputTokens: 1200, compactions: 1 },
      },
      {
        id: "a2",
        role: "assistant",
        content: "done2",
        compactedThisTurn: true,
        tokenEconomics: { rounds: 6, promptTokens: 120000, outputTokens: 1500, compactions: 2 },
      },
      {
        id: "a3",
        role: "assistant",
        content: "legacy",
        compactedThisTurn: true,
      },
    ];
    assert.equal(
      countCompactions(messages as never),
      4,
      "1 + 2 + 1 = 4 compactions (never 2 + 3 + 1 = 6)"
    );
  });

  it("Fix 3: resolveDisplayContextTokens reflects post-compaction truth and ChatStream resets contextStats on thread switch", () => {
    const resolveFn = (contextSegmentsMod as Record<string, unknown>).resolveDisplayContextTokens as
      | ((params: {
          messages: Array<{ roundPromptTokens?: number[]; timestamp?: string }> | undefined;
          estimatedTokens: number;
          compaction?: { compactedAt?: string; tokensAfter?: number } | null;
        }) => number)
      | undefined;
    assert.equal(typeof resolveFn, "function", "resolveDisplayContextTokens must be exported");

    // Pre-compaction message has 88K prompt tokens; manual compaction ran AFTER it reducing to 22K
    const messages = [
      {
        role: "assistant",
        roundPromptTokens: [88000],
        timestamp: "2026-11-27T10:00:00.000Z",
      },
    ];
    assert.equal(
      resolveFn!({
        messages,
        estimatedTokens: 22000,
        compaction: { compactedAt: "2026-11-27T10:05:00.000Z", tokensAfter: 22000 },
      }),
      22000,
      "after compaction, meter must show post-compaction tokens instead of stale roundPromptTokens"
    );

    // After a newer turn lands, the new roundPromptTokens wins again
    const messagesAfterNewTurn = [
      ...messages,
      {
        role: "assistant",
        roundPromptTokens: [31000],
        timestamp: "2026-11-27T10:10:00.000Z",
      },
    ];
    assert.equal(
      resolveFn!({
        messages: messagesAfterNewTurn,
        estimatedTokens: 22000,
        compaction: { compactedAt: "2026-11-27T10:05:00.000Z", tokensAfter: 22000 },
      }),
      31000,
      "once a newer round persists after compaction, its roundPromptTokens must win"
    );

    // ChatStream must reset contextStats.estimatedTokens on thread switch
    const chatStreamSrc = fs.readFileSync(path.join(componentsDir, "ChatStream.tsx"), "utf-8");
    assert.ok(
      chatStreamSrc.includes("resolveDisplayContextTokens"),
      "ChatStream must use resolveDisplayContextTokens for displayContextTokens"
    );
    const switchEffectIdx = chatStreamSrc.indexOf("Rehydration of thread compaction boundary");
    assert.ok(switchEffectIdx > 0);
    const switchWindow = chatStreamSrc.slice(switchEffectIdx, switchEffectIdx + 1200);
    assert.ok(
      switchWindow.includes("estimatedTokens: 0"),
      "ChatStream must reset contextStats.estimatedTokens to 0 on thread switch"
    );
  });

  it("Fix 4: deriveContextSegments counts each trace once even when present in both m.traces and liveTraces", () => {
    const sharedTrace = {
      tool: "workspace_read_file",
      args: { path: "a.ts" },
      result: "payload ".repeat(200),
      durationMs: 12,
      timestamp: "2026-11-27T10:00:00.000Z",
    };
    const clonedTrace = { ...sharedTrace };
    const messages = [{ id: "a1", role: "assistant", content: "ok", traces: [sharedTrace] }];

    const onlyMessages = deriveContextSegments(messages as never, []);
    const withSameRef = deriveContextSegments(messages as never, [sharedTrace]);
    const withClone = deriveContextSegments(messages as never, [clonedTrace]);

    assert.equal(
      withSameRef.toolResults,
      onlyMessages.toolResults,
      "identical trace object in liveTraces must not be double-counted"
    );
    assert.equal(
      withClone.toolResults,
      onlyMessages.toolResults,
      "cloned trace with same tool/timestamp/result in liveTraces must not be double-counted"
    );
  });

  it("Fix 5: ContextSheet guards Restore while streaming/compacting and handles Escape to close", () => {
    const boundary = {
      summary: "DIGEST",
      compactedAt: "2026-11-25T10:00:00Z",
      tokensBefore: 91000,
      tokensAfter: 38000,
    };
    const htmlStreaming = renderToString(
      React.createElement(ContextSheet, {
        open: true,
        onClose: () => {},
        usedTokens: 50000,
        budgetTokens: 100000,
        triggerTokens: 85000,
        segments: { toolResults: 20000, conversation: 20000, system: 10000 },
        lastRoundPromptTokens: 50000,
        compactionCount: 1,
        compaction: boundary,
        isStreaming: true,
        isCompacting: false,
        onCompact: () => {},
        onRestore: () => {},
      })
    );
    const restoreIdx = htmlStreaming.indexOf('data-testid="context-sheet-restore"');
    assert.ok(restoreIdx > 0, "restore button must render when boundary exists");
    const buttonStart = htmlStreaming.lastIndexOf("<button", restoreIdx);
    const buttonEnd = htmlStreaming.indexOf(">", restoreIdx);
    const restoreOpenTag = htmlStreaming.slice(buttonStart, buttonEnd + 1);
    assert.ok(
      /\bdisabled(?:=""|\b)/.test(restoreOpenTag),
      "Restore full history button must have disabled attribute while streaming"
    );

    const sheetSrc = fs.readFileSync(path.join(componentsDir, "ContextSheet.tsx"), "utf-8");
    assert.ok(
      sheetSrc.includes('"Escape"') || sheetSrc.includes("'Escape'"),
      "ContextSheet must handle Escape key to close"
    );
  });
});
