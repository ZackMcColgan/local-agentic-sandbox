import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatMessageTimestamp } from "../lib/chatUtils";

describe("UI-042: formatMessageTimestamp", () => {
  const now = new Date(2026, 10, 14, 10, 30, 0); // Nov 14, 2026 10:30 AM

  it("formats today's fresh timestamp (<1m) with relative 'Now' label", () => {
    const fresh = new Date(2026, 10, 14, 10, 29, 45);
    const out = formatMessageTimestamp(fresh, now);
    assert.match(out, /Now$/);
  });

  it("formats today's recent timestamp (<1h) with relative 'm ago' label", () => {
    const recent = new Date(2026, 10, 14, 10, 25, 0);
    const out = formatMessageTimestamp(recent, now);
    assert.match(out, /5m ago$/);
  });

  it("formats older-than-today timestamp with month and day date", () => {
    const yesterday = new Date(2026, 10, 13, 3, 33, 0);
    const out = formatMessageTimestamp(yesterday, now);
    assert.match(out, /Nov\s+13/);
    assert.doesNotMatch(out, /Now|ago/);
  });

  it("returns raw string for invalid timestamp", () => {
    assert.equal(formatMessageTimestamp("not-a-date", now), "not-a-date");
  });
});
