import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Smart Streaming Scroll Follow & Sticky Pill", () => {
  const chatStreamPath = path.resolve(__dirname, "../components/ChatStream.tsx");
  const content = fs.readFileSync(chatStreamPath, "utf-8");

  it("checks distanceFromBottom threshold of 90-100px to avoid jumpy disengagement", () => {
    assert.ok(
      content.includes("distanceFromBottom > 90") || content.includes("distanceFromBottom > 100"),
      "ChatStream must check distanceFromBottom before disengaging auto-follow"
    );
  });

  it("sets scrollTop directly to scrollHeight during streaming without smooth scroll queue fighting", () => {
    assert.ok(
      content.includes("el.scrollTop = el.scrollHeight"),
      "ChatStream must set el.scrollTop = el.scrollHeight directly for instant lock during token streaming"
    );
  });

  it("provides a 'Jump to bottom' sticky button with touch-friendly dimensions when user scrolls up", () => {
    assert.ok(
      content.includes("Jump to bottom"),
      "ChatStream must provide 'Jump to bottom' pill when scrolled up"
    );
    assert.ok(
      content.includes("min-h-[44px]") || content.includes("h-11") || content.includes("py-2.5"),
      "Jump to bottom button must be touch friendly (>= 44px hit target)"
    );
  });

  it("restores auto-follow mode when user clicks Jump to bottom", () => {
    assert.ok(
      content.includes("scrollToBottom"),
      "ChatStream must implement scrollToBottom"
    );
    assert.ok(
      content.includes("setIsUserScrolledUp(false)"),
      "scrollToBottom must reset isUserScrolledUp to false"
    );
  });

  it("simulates scroll distance threshold logic", () => {
    function computeIsUserScrolledUp(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      return distanceFromBottom > 90;
    }

    // At the bottom: distance is 0 -> follow mode
    assert.equal(computeIsUserScrolledUp(1000, 600, 400), false);
    // Slight drift of 50px (e.g. fast token render) -> still follow mode
    assert.equal(computeIsUserScrolledUp(1000, 550, 400), false);
    // Boundary 90px -> still follow mode
    assert.equal(computeIsUserScrolledUp(1000, 510, 400), false);
    // User intentionally scrolls up > 90px -> breaks follow mode
    assert.equal(computeIsUserScrolledUp(1000, 490, 400), true);
    assert.equal(computeIsUserScrolledUp(1000, 100, 400), true);
  });
});
