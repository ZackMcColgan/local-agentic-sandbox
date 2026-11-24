import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewerVerdictContent } from "../lib/board/productionStageDeps";

// Stage 0 measurement repair: the reviewer model emits its verdict as a markdown
// heading ("## Verdict: **PASS**"). The parser must tolerate heading markers,
// bold markers, and combinations, while staying fail-closed on genuinely
// unparseable output.

test("parseReviewerVerdictContent parses a heading verdict with bold verdict token", () => {
  const verdict = parseReviewerVerdictContent(
    "thread-1",
    [
      "## Verdict: **PASS**",
      "",
      "- All behavioral acceptance criteria satisfied.",
      "- No banned patterns in the diff.",
    ].join("\n")
  );
  assert.equal(verdict.verdict, "PASS");
  assert.equal(verdict.threadId, "thread-1");
  assert.ok(verdict.evidence.some((e) => e.includes("behavioral acceptance criteria")));
});

test("parseReviewerVerdictContent parses a level-3 heading FAIL verdict", () => {
  const verdict = parseReviewerVerdictContent(
    "thread-2",
    ["### Verdict: FAIL", "- Missing error handling on bridge disconnect."].join("\n")
  );
  assert.equal(verdict.verdict, "FAIL");
  assert.ok(verdict.evidence.some((e) => e.includes("Missing error handling")));
});

test("parseReviewerVerdictContent parses bold label with plain verdict token", () => {
  const verdict = parseReviewerVerdictContent(
    "thread-3",
    ["**Verdict:** PASS", "- Diff matches the brief."].join("\n")
  );
  assert.equal(verdict.verdict, "PASS");
});

test("parseReviewerVerdictContent parses plain Verdict label and bare verdict token", () => {
  assert.equal(parseReviewerVerdictContent("thread-4", "Verdict: PASS").verdict, "PASS");
  assert.equal(parseReviewerVerdictContent("thread-5", "Verdict: FAIL").verdict, "FAIL");
  assert.equal(parseReviewerVerdictContent("thread-6", "PASS").verdict, "PASS");
  assert.equal(parseReviewerVerdictContent("thread-7", "FAIL").verdict, "FAIL");
});

test("parseReviewerVerdictContent fails closed with unparseable evidence note when no verdict line exists", () => {
  const verdict = parseReviewerVerdictContent("thread-8", "Looks mostly okay, maybe ship it?");
  assert.equal(verdict.verdict, "FAIL");
  assert.ok(verdict.evidence.some((e) => /unparseable/i.test(e)));
});

test("parseReviewerVerdictContent does not treat prose containing pass/fail words as a verdict", () => {
  const verdict = parseReviewerVerdictContent(
    "thread-9",
    ["The suite passes locally.", "Failure modes were reviewed."].join("\n")
  );
  assert.equal(verdict.verdict, "FAIL");
  assert.ok(verdict.evidence.some((e) => /unparseable/i.test(e)));
});
