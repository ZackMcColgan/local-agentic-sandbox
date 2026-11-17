import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI_ROOT = path.resolve(import.meta.dirname, "..");

function readComponent(relPath: string): string {
  return fs.readFileSync(path.join(WEB_UI_ROOT, relPath), "utf8");
}

describe("UI-087: queue deck scroller + steer deck remove & clear-all", () => {
  it("keeps Clear all outside the horizontal chips scroller on queue and steer decks", () => {
    const src = readComponent("components/ChatStream.tsx");

    // Queue deck: outer deck should NOT have overflow-x-auto; inner chips container should
    const queueDeckMatch = src.match(/data-testid="chat-queue-deck"[^>]*className="([^"]+)"/);
    assert.ok(queueDeckMatch, "chat-queue-deck should exist");
    assert.ok(
      !queueDeckMatch[1].includes("overflow-x-auto"),
      "chat-queue-deck outer container should not have overflow-x-auto (Clear all must stay pinned outside)"
    );

    const queueBlock = src.slice(src.indexOf('data-testid="chat-queue-deck"'), src.indexOf('data-testid="chat-queue-clear-all"'));
    assert.ok(
      queueBlock.includes("flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-none"),
      "queue chips container should be the horizontal scroller (overflow-x-auto scrollbar-none)"
    );

    // Steer deck: outer deck should NOT have overflow-x-auto; inner chips container should
    const steerDeckMatch = src.match(/data-testid="chat-steer-pending-deck"[^>]*className="([^"]+)"/);
    assert.ok(steerDeckMatch, "chat-steer-pending-deck should exist");
    assert.ok(
      !steerDeckMatch[1].includes("overflow-x-auto"),
      "chat-steer-pending-deck outer container should not have overflow-x-auto"
    );
  });

  it("renders per-chip remove button and Clear all on steer deck", () => {
    const src = readComponent("components/ChatStream.tsx");
    assert.ok(
      src.includes("aria-label={`Remove steer item ${idx + 1}`}"),
      "steer chip should render per-item remove button with aria-label"
    );
    assert.ok(
      src.includes('data-testid="chat-steer-clear-all"'),
      "steer deck should render Clear all button with data-testid=chat-steer-clear-all"
    );
    assert.ok(
      src.includes("setPendingSteers((prev) => prev.filter((_, i) => i !== idx))"),
      "removing a steer item should drop only that index"
    );
    assert.ok(
      src.includes("setPendingSteers([])"),
      "Clear all on steer deck should empty pendingSteers"
    );
  });
});

describe("UI-083: board scrolling on mobile", () => {
  it("tracks touch start in a ref rather than React state", () => {
    const src = readComponent("components/BoardView.tsx");
    assert.ok(
      !src.includes("setTouchStartX"),
      "BoardView should not use React state (setTouchStartX) for touch tracking"
    );
    assert.ok(
      src.includes("useRef"),
      "BoardView should use a ref for touch start coordinates"
    );
  });

  it("requires horizontal dominance (|dx| > 50 && |dx| > 2 * |dy|) to flip columns", () => {
    const src = readComponent("components/BoardView.tsx");
    assert.ok(
      src.includes("Math.abs(dx) > 50") && src.includes("Math.abs(dx) > 2 * Math.abs(dy)"),
      "BoardView should require |dx| > 50 and |dx| > 2 * |dy| before flipping columns"
    );
  });

  it("applies touch-pan-y and overscroll-contain to the column list container", () => {
    const src = readComponent("components/BoardView.tsx");
    assert.ok(
      src.includes("touch-pan-y") && src.includes("overscroll-contain"),
      "BoardView column list container should carry touch-pan-y and overscroll-contain"
    );
  });
});

describe("UI-085: drawer menu text contrast", () => {
  it("uses dark:text-zinc-100 for nav item labels and dark:text-zinc-300 for nav icons", () => {
    const src = readComponent("components/NavigationDrawer.tsx");
    assert.ok(
      !src.includes("dark:text-zinc-500"),
      "NavigationDrawer should not contain dark:text-zinc-500"
    );
    assert.ok(
      !src.includes("text-slate-700 dark:text-zinc-300 hover:bg-slate-100"),
      "Nav item labels should be raised from dark:text-zinc-300 to dark:text-zinc-100"
    );
    assert.ok(
      src.includes("text-slate-700 dark:text-zinc-100 hover:bg-slate-100"),
      "Nav item labels should use dark:text-zinc-100"
    );
    assert.ok(
      !src.includes("h-5 w-5 text-slate-600 dark:text-zinc-400 shrink-0"),
      "Nav item icons should be raised from dark:text-zinc-400 to dark:text-zinc-300"
    );
    assert.ok(
      src.includes("h-5 w-5 text-slate-600 dark:text-zinc-300 shrink-0"),
      "Nav item icons should use dark:text-zinc-300"
    );
  });
});

describe("UI-084: chat header room", () => {
  it("gives the chat header bar min-h-[56px] and vertical padding", () => {
    const src = readComponent("components/ChatStream.tsx");
    assert.ok(
      src.includes("sticky top-0 z-30 min-h-[56px] py-1.5"),
      "ChatStream header should have min-h-[56px] and py-1.5"
    );
  });
});
