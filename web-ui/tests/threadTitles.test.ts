import { describe, it, expect } from "vitest";
import {
  THREAD_TITLE_MAX_CHARS,
  deriveStoredThreadTitle,
  deriveThreadTitle,
} from "../lib/threads/threadStore";

describe("thread title derivation", () => {
  it("exposes THREAD_TITLE_MAX_CHARS as 80", () => {
    expect(THREAD_TITLE_MAX_CHARS).toBe(80);
  });

  it("returns 'New thread' for undefined, empty, or whitespace-only input", () => {
    expect(deriveStoredThreadTitle(undefined)).toBe("New thread");
    expect(deriveStoredThreadTitle("")).toBe("New thread");
    expect(deriveStoredThreadTitle("   \n  \t ")).toBe("New thread");
    expect(deriveThreadTitle(undefined)).toBe("New thread");
    expect(deriveThreadTitle("")).toBe("New thread");
  });

  it("strips Session: and JOB — / JOB: / JOB- prefixes case-insensitively and when stacked", () => {
    expect(deriveStoredThreadTitle("Session: Fix login bug")).toBe("Fix login bug");
    expect(deriveStoredThreadTitle("session:   Fix login bug")).toBe("Fix login bug");
    expect(deriveStoredThreadTitle("JOB — Audit tests")).toBe("Audit tests");
    expect(deriveStoredThreadTitle("job - Audit tests")).toBe("Audit tests");
    expect(deriveStoredThreadTitle("JOB – Audit tests")).toBe("Audit tests");
    expect(deriveStoredThreadTitle("JOB: Session: Audit tests")).toBe("Audit tests");
    expect(deriveStoredThreadTitle("Session: JOB — Nested")).toBe("Nested");
  });

  it("leaves ordinary words starting with job or session intact", () => {
    expect(deriveStoredThreadTitle("Jobs queue refactor")).toBe("Jobs queue refactor");
    expect(deriveStoredThreadTitle("Sessions list UI")).toBe("Sessions list UI");
  });

  it("collapses multi-line input to the first line", () => {
    expect(deriveStoredThreadTitle("First line summary\nSecond line details\r\nThird")).toBe(
      "First line summary"
    );
  });

  it("truncates at a word boundary when exceeding maxChars", () => {
    const input =
      "Implement a comprehensive thread title derivation utility that truncates cleanly at word boundaries";
    const derived = deriveThreadTitle(input, 40);
    expect(derived.length).toBeLessThanOrEqual(40);
    expect(derived).toBe("Implement a comprehensive thread title");
  });

  it("hard-cuts at maxChars when there is no whitespace before the cap", () => {
    const noSpaces = "a".repeat(100);
    expect(deriveThreadTitle(noSpaces, 25)).toBe("a".repeat(25));
  });
});
