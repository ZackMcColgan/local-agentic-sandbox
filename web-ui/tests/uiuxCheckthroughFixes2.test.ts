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
