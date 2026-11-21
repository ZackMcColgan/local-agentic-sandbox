import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THREAD_TITLE_MAX_CHARS,
  deriveStoredThreadTitle,
  deriveThreadTitle,
} from "../lib/threads/titles";

describe("thread title derivation", () => {
  it("exposes THREAD_TITLE_MAX_CHARS as 80", () => {
    assert.equal(THREAD_TITLE_MAX_CHARS, 80);
  });

  it("returns 'New thread' for undefined, empty, or whitespace-only input", () => {
    assert.equal(deriveStoredThreadTitle(undefined), "New thread");
    assert.equal(deriveStoredThreadTitle(""), "New thread");
    assert.equal(deriveStoredThreadTitle("   \n  \t "), "New thread");
    assert.equal(deriveThreadTitle(undefined), "New thread");
    assert.equal(deriveThreadTitle(""), "New thread");
  });

  it("strips Session: and JOB — / JOB: / JOB- prefixes case-insensitively and when stacked", () => {
    assert.equal(deriveStoredThreadTitle("Session: Fix login bug"), "Fix login bug");
    assert.equal(deriveStoredThreadTitle("session:   Fix login bug"), "Fix login bug");
    assert.equal(deriveStoredThreadTitle("JOB — Audit tests"), "Audit tests");
    assert.equal(deriveStoredThreadTitle("job - Audit tests"), "Audit tests");
    assert.equal(deriveStoredThreadTitle("JOB – Audit tests"), "Audit tests");
    assert.equal(deriveStoredThreadTitle("JOB: Session: Audit tests"), "Audit tests");
    assert.equal(deriveStoredThreadTitle("Session: JOB — Nested"), "Nested");
  });

  it("leaves ordinary words starting with job or session intact", () => {
    assert.equal(deriveStoredThreadTitle("Jobs queue refactor"), "Jobs queue refactor");
    assert.equal(deriveStoredThreadTitle("Sessions list UI"), "Sessions list UI");
  });

  it("collapses multi-line input to the first line", () => {
    assert.equal(
      deriveStoredThreadTitle("First line summary\nSecond line details\r\nThird"),
      "First line summary"
    );
  });

  it("truncates at a word boundary when exceeding maxChars", () => {
    const input =
      "Implement a comprehensive thread title derivation utility that truncates cleanly at word boundaries";
    const derived = deriveThreadTitle(input, 40);
    assert.ok(derived.length <= 40);
    assert.equal(derived, "Implement a comprehensive thread title");
  });

  it("hard-cuts at maxChars when there is no whitespace before the cap", () => {
    const noSpaces = "a".repeat(100);
    assert.equal(deriveThreadTitle(noSpaces, 25), "a".repeat(25));
  });
});
