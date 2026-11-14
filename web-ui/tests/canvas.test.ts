import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDiffFiles } from "../components/ArtifactCanvas";
import { CodeBlock } from "../components/ArtifactRenderers";

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

describe("E2: CodeBlock plain-text fallback & clean SVG naming (UI-039)", () => {
  it("CodeBlock with language={undefined} and code='391' never renders 'bash' or 'snippet.bash'", () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: undefined, code: "391" })
    );
    assert.equal(html.includes("bash"), false, `Expected no 'bash' in: ${html}`);
    assert.equal(html.includes("snippet.bash"), false, `Expected no 'snippet.bash' in: ${html}`);
  });

  it("unnamed SVG uses 'diagram.svg' or its <title> instead of 'snippet.svg'", () => {
    const plainSvg = "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>";
    const htmlPlain = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: "svg", code: plainSvg })
    );
    assert.equal(htmlPlain.includes("snippet.svg"), false);

    const titledSvg = "<svg viewBox=\"0 0 10 10\"><title>System Flow</title><rect width=\"10\" height=\"10\"/></svg>";
    const htmlTitled = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: "svg", code: titledSvg })
    );
    assert.equal(htmlTitled.includes("snippet.svg"), false);
  });
});
