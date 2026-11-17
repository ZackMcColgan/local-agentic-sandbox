import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardView } from "../components/BoardView";
import { BoardAddSheet } from "../components/BoardAddSheet";
import type { BoardItem } from "../lib/board/boardStore";

const SAMPLE_ITEMS: BoardItem[] = [
  {
    id: "item-16",
    key: "#16",
    title: "command-dialect-guard",
    brief: "Pre-execution host-command lint. Rewrites and rejections stay visible in traces.",
    dependencies: ["item-15"],
    status: "queued",
    author: "Owner",
    source: "manual",
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  },
  {
    id: "item-15",
    key: "#15",
    title: "tool-call-integrity",
    brief: "Markup-in-content detector + zero-trace tripwire. Failed calls end the turn honestly.",
    dependencies: [],
    status: "working",
    author: "Owner",
    source: "manual",
    evidence: {
      liveLine: "Run live since 23:22 — Phase 1 of 2 · in status 24m",
    },
    threadLink: "/?thread=thread-15",
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  },
  {
    id: "item-qwen4",
    key: "PARK-1",
    title: "qwen4-intake",
    brief: "Evaluate Qwen 4 weights when released.",
    dependencies: [],
    status: "parked",
    author: "Owner",
    source: "manual",
    parkedReason: "Trigger not met — waits on Qwen 4 weights",
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  },
  {
    id: "item-110",
    key: "#110",
    title: "inapp-supervisor",
    brief: "In-app supervisor for overnight runs.",
    dependencies: [],
    status: "done",
    author: "Owner",
    source: "manual",
    evidence: {
      prNumber: 110,
      mergeSha: "db37bc6",
      deployTag: "deployed",
    },
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
  },
];

describe("Board UI", () => {
  it("renders all five columns with counts, search row, and card details", () => {
    const html = renderToStaticMarkup(
      React.createElement(BoardView, {
        items: SAMPLE_ITEMS,
        onOpenDrawer: () => {},
        onItemCreated: () => {},
        onAskAssistant: () => {},
      })
    );

    // Five columns
    assert.match(html, /QUEUED/);
    assert.match(html, /WORKING/);
    assert.match(html, /PR OPEN/);
    assert.match(html, /PARKED/);
    assert.match(html, /DONE/);

    // Search row
    assert.match(html, /Search the board/);

    // Card details: name, key, description, meta tags
    assert.match(html, /command-dialect-guard/);
    assert.match(html, /#16/);
    assert.match(html, /Pre-execution host-command lint/);

    // Working card live evidence + Brief and Thread links
    assert.match(html, /tool-call-integrity/);
    assert.match(html, /Run live since 23:22/);
    assert.match(html, /Brief/);
    assert.match(html, /Thread/);

    // Parked card reason
    assert.match(html, /qwen4-intake/);
    assert.match(html, /Trigger not met — waits on Qwen 4 weights/);
  });

  it("renders the add sheet with both doors and the rule line", () => {
    const html = renderToStaticMarkup(
      React.createElement(BoardAddSheet, {
        isOpen: true,
        existingItems: SAMPLE_ITEMS,
        onClose: () => {},
        onAskAssistant: () => {},
        onCreateManual: async () => {},
      })
    );

    assert.match(html, /Add to the board/);
    assert.match(html, /New items land in Queued\. Nothing reaches the board without you behind it\./);
    assert.match(html, /Ask the assistant/);
    assert.match(html, /Write it myself/);
    assert.match(html, /However it arrives, the item shows its author\./);
    assert.match(html, /The loop never adds items on its own\./);
  });

  it("contains no assistant brand or personal names in board UI files or seeded data", () => {
    const boardFiles = [
      path.resolve(__dirname, "../components/BoardView.tsx"),
      path.resolve(__dirname, "../components/BoardAddSheet.tsx"),
      path.resolve(__dirname, "../lib/board/boardStore.ts"),
      path.resolve(__dirname, "../lib/board/boardSeed.ts"),
    ];

    const forbidden = [
      /\bZack\b/i,
      /\bMcColgan\b/i,
      /\bClaude\b/i,
      /\bAnthropic\b/i,
      /\bGemini\b/i,
      /\bOpenAI\b/i,
      /\bChatGPT\b/i,
      /\bCopilot\b/i,
      /\bAntigravity\b/i,
      /\bHydrogen\b/i,
    ];

    for (const filePath of boardFiles) {
      assert.ok(fs.existsSync(filePath), `Expected board file to exist: ${filePath}`);
      const content = fs.readFileSync(filePath, "utf8");
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          content,
          pattern,
          `Forbidden brand/personal name ${pattern} found in ${path.basename(filePath)}`
        );
      }
    }
  });
});
