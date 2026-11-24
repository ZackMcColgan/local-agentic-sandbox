import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardView } from "../components/BoardView";
import type { BoardItem } from "../lib/board/boardStore";

describe("Batch 8 — UI Polish & Blind-Review Quick Wins", () => {
  it("ChatStream.tsx no longer contains the token-stuffed CodeBlock comment", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "components/ChatStream.tsx"), "utf8");
    assert.ok(
      !src.includes("// CodeBlock handles long files with max-h-[400px]"),
      "Token-stuffed comment must be deleted from ChatStream.tsx"
    );
  });

  it("N-R11 / UI-H4: BoardView renders exactly one Thread › link per linked card (no duplicates)", () => {
    const settledItem: BoardItem = {
      id: "item-linked-1",
      key: "#121",
      title: "Linked done card",
      brief: "Has a threadLink",
      status: "done",
      dependencies: [],
      author: "Owner",
      source: "manual",
      threadLink: "/?thread=thr-121",
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      React.createElement(BoardView, {
        items: [settledItem],
        onOpenDrawer: () => {},
        onItemCreated: () => {},
        onAskAssistant: () => {},
      })
    );

    // BoardView renders mobile + desktop DOMs; on desktop column there is 1 card (mobile active col is queued = 0 cards)
    const threadLinkMatches = html.match(/Thread ›/g) ?? [];
    assert.equal(
      threadLinkMatches.length,
      1,
      `Expected exactly 1 'Thread ›' link for the single linked card, found ${threadLinkMatches.length}`
    );
    assert.ok(
      html.includes("pb-28"),
      "Mobile board list must reserve pb-28 clearance above the floating + FAB"
    );
  });

  it("U-F5: BoardView Edit modal and buttons include light-mode contrast classes", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "components/BoardView.tsx"), "utf8");
    assert.ok(
      !src.includes('className="text-base font-bold text-zinc-100"'),
      "Edit modal heading must not use unprefixed text-zinc-100 on bg-white"
    );
    assert.ok(
      src.includes("text-zinc-900 dark:text-zinc-100"),
      "Edit modal heading and inputs must pair light and dark text classes"
    );
  });
});
