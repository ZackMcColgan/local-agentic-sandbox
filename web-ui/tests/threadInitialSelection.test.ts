import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// @ts-ignore - resolved at test time
import { pickMostRecentlyActiveThread } from "../lib/liveActivity";

describe("UI-009: fresh load opens the most recently active thread", () => {
  it("picks the thread with the latest updatedAt regardless of array order", () => {
    const threads = [
      { id: "t-old", updatedAt: "2026-11-14T10:00:00.000Z", createdAt: "2026-11-14T09:00:00.000Z" },
      { id: "t-newest", updatedAt: "2026-11-15T12:30:00.000Z", createdAt: "2026-11-14T08:00:00.000Z" },
      { id: "t-mid", updatedAt: "2026-11-15T08:00:00.000Z", createdAt: "2026-11-15T07:00:00.000Z" },
    ];
    const picked = pickMostRecentlyActiveThread(threads);
    assert.equal(picked?.id, "t-newest");
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    const threads = [
      { id: "t-1", createdAt: "2026-11-14T10:00:00.000Z" },
      { id: "t-2", createdAt: "2026-11-15T10:00:00.000Z" },
    ];
    const picked = pickMostRecentlyActiveThread(threads);
    assert.equal(picked?.id, "t-2");
  });

  it("returns null for an empty list", () => {
    assert.equal(pickMostRecentlyActiveThread([]), null);
  });

  it("page.tsx uses pickMostRecentlyActiveThread for the no-explicit-thread default", () => {
    const pageSrc = fs.readFileSync(path.join(process.cwd(), "app/page.tsx"), "utf8");
    assert.match(pageSrc, /pickMostRecentlyActiveThread\s*\(/);
  });
});
