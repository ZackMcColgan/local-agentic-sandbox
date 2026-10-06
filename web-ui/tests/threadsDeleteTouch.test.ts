import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Regression test: tapping "Confirm?" on the session delete button must not
// have its confirm state reset by the parent card's onTouchEnd handler.
// Bug found 2026-10-06: onTouchEnd fired before the button's onClick and
// cleared confirmDeleteId on any rightward finger drift, so the delete never fired.

describe("ThreadsSidebar — delete confirm touch handling", () => {
  it("onTouchEnd skips confirm reset when touch ends on a button", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sidebarPath = path.join(process.cwd(), "components/ThreadsSidebar.tsx");
    const source = fs.readFileSync(sidebarPath, "utf-8");

    // The touch-end handler must bail out when the touch target is a button,
    // preserving the confirm state for the button's onClick.
    assert.ok(
      source.includes('closest("button")'),
      "ThreadsSidebar onTouchEnd must guard against resetting confirm state when touching a button"
    );
  });
});
