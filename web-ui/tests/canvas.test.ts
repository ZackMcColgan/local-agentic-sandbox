import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDiffFiles } from "../components/ArtifactCanvas";

describe("E1: buildDiffFiles deduplication (UI-032 + NEW-ARGON-07)", () => {
  it("deduplicates same path and prefers unified diff with removedLines > 0 or @@ hunk headers", () => {
    const fileWriteDiff = {
      path: "./hero.svg",
      diff: Array.from({ length: 32 }, (_, i) => `+line ${i + 1}`).join("\n"),
    };
    const msgUnifiedDiff = {
      path: "hero.svg",
      diff: [
        "@@ -1,5 +1,8 @@",
        " <svg>",
        "-  <rect />",
        "-  <circle />",
        "+  <rect width=\"100\" />",
        "+  <circle r=\"20\" />",
        "+  <path d=\"M0 0\" />",
        "+  <text>Hi</text>",
        "+  <g />",
        " </svg>",
      ].join("\n"),
    };

    const result = buildDiffFiles([fileWriteDiff, msgUnifiedDiff]);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, "hero.svg");
    assert.equal(result[0].addedLines, 5);
    assert.equal(result[0].removedLines, 2);
  });
});
