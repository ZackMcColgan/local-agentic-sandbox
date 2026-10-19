import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSearchQuery,
  evaluateSearchQueryAttempt,
  hasSubstantiveWebResults,
  isMetaChallenge,
  shouldInjectHonestAbort,
  HONEST_ABORT_DIRECTIVE
} from "../lib/grounding";

test("isValidSearchQuery: accepts concise information need query", () => {
  assert.equal(isValidSearchQuery("Spanish Fort AL hourly forecast today"), true);
});

test("isValidSearchQuery: rejects verbatim user prompt (>4 words)", () => {
  const prompt = "What is the weather today in Spanish Fort AL";
  assert.equal(isValidSearchQuery(prompt, prompt), false);
});

test("isValidSearchQuery: rejects denylisted challenge/instruction/format phrasing", () => {
  assert.equal(
    isValidSearchQuery("Did you actually read the weather? Create a svg for the 5 days"),
    false
  );
  assert.equal(isValidSearchQuery("Where is the updated svg?"), false);
});

test("isValidSearchQuery: boundary checks for length (empty, 200 chars, 201 chars)", () => {
  assert.equal(isValidSearchQuery(""), false);
  assert.equal(isValidSearchQuery(" "), false);
  assert.equal(isValidSearchQuery("a"), false);

  const query200 = "Spanish Fort AL weather forecast today with hourly cloud cover wind humidity rain details ".padEnd(200, "x");
  assert.equal(query200.length, 200);
  assert.equal(isValidSearchQuery(query200), true);

  const query201 = query200 + "x";
  assert.equal(query201.length, 201);
  assert.equal(isValidSearchQuery(query201), false);
});

test("evaluateSearchQueryAttempt helper: first invalid -> nudge, countAttempt false; second invalid -> block, countAttempt true; valid -> proceed", () => {
  const userPrompt = "Create a svg of the weather today in Spanish Fort AL";

  // First invalid attempt (nudgesUsed = 0)
  const firstAttempt = evaluateSearchQueryAttempt("Create a svg of the weather", userPrompt, 0);
  assert.equal(firstAttempt.action, "nudge");
  assert.equal(firstAttempt.countAttempt, false);
  assert.ok(firstAttempt.message && firstAttempt.message.length > 0);

  // Second invalid attempt (nudgesUsed = 1)
  const secondAttempt = evaluateSearchQueryAttempt("Create a svg of the weather", userPrompt, 1);
  assert.equal(secondAttempt.action, "block");
  assert.equal(secondAttempt.countAttempt, true);
  assert.ok(secondAttempt.message && secondAttempt.message.length > 0);

  // Missing/empty query (first attempt -> nudge, second attempt -> block)
  const emptyFirst = evaluateSearchQueryAttempt("", userPrompt, 0);
  assert.equal(emptyFirst.action, "nudge");
  assert.equal(emptyFirst.countAttempt, false);

  const emptySecond = evaluateSearchQueryAttempt("", userPrompt, 1);
  assert.equal(emptySecond.action, "block");
  assert.equal(emptySecond.countAttempt, true);

  // Valid query -> proceed
  const validAttempt = evaluateSearchQueryAttempt("Spanish Fort AL hourly forecast today", userPrompt, 0);
  assert.equal(validAttempt.action, "proceed");
  assert.equal(validAttempt.countAttempt, false);
});

test("isMetaChallenge classification test (abort-path use)", () => {
  assert.equal(isMetaChallenge("Did you actually look up the weather?"), true);
  assert.equal(isMetaChallenge("Have you even checked the live data?"), true);
  assert.equal(isMetaChallenge("You made that up"), true);
  assert.equal(isMetaChallenge("Are you sure?"), true);
  assert.equal(isMetaChallenge("Is that accurate?"), true);
  assert.equal(isMetaChallenge("What is recursion?"), false);
});

const longText = "Spanish Fort, AL forecast: sunny with highs near 78F. ".repeat(10);

test("hasSubstantiveWebResults: false for no web traces", () => {
  assert.equal(hasSubstantiveWebResults([]), false);
  assert.equal(hasSubstantiveWebResults([{ tool: "bash", result: longText }]), false);
});

test("hasSubstantiveWebResults: false for empty / no-results / error shapes", () => {
  assert.equal(hasSubstantiveWebResults([{ tool: "search_web", result: "" }]), false);
  assert.equal(hasSubstantiveWebResults([{ tool: "search_web", result: { results: [] } }]), false);
  assert.equal(hasSubstantiveWebResults([{ tool: "search_web", result: "No results found for query." }]), false);
  assert.equal(hasSubstantiveWebResults([{ tool: "search_web", result: { error: "timeout " + longText } }]), false);
  assert.equal(
    hasSubstantiveWebResults([{ tool: "search_web", result: { content: [{ type: "text", text: "No results found." }] } }]),
    false
  );
  assert.equal(
    hasSubstantiveWebResults([{ tool: "search_web", result: { isError: true, content: [{ type: "text", text: longText }] } }]),
    false
  );
});

test("hasSubstantiveWebResults: true for real content", () => {
  assert.equal(
    hasSubstantiveWebResults([{ tool: "search_web", result: { content: [{ type: "text", text: longText }] } }]),
    true
  );
  assert.equal(hasSubstantiveWebResults([{ tool: "fetch_webpage_markdown", result: longText }]), true);
});

test("Oct 19 regression: empty search on live intent injects honest abort", () => {
  const traces = [{ tool: "search_web", args: { query: "weather Spanish Fort AL" }, result: { results: [] } }];
  assert.equal(
    shouldInjectHonestAbort({ userPrompt: "Create a svg of the weather today in Spanish Fort AL", webResearchCalls: 1, traces }),
    true
  );
  assert.match(HONEST_ABORT_DIRECTIVE, /could not be retrieved/i);
  assert.match(HONEST_ABORT_DIRECTIVE, /Do NOT state any temperatures/);
});

test("honest abort not injected when results are substantive or no search ran", () => {
  const good = [{ tool: "search_web", result: longText }];
  assert.equal(shouldInjectHonestAbort({ userPrompt: "weather today in Mobile AL", webResearchCalls: 1, traces: good }), false);
  assert.equal(shouldInjectHonestAbort({ userPrompt: "weather today in Mobile AL", webResearchCalls: 0, traces: [] }), false);
  assert.equal(
    shouldInjectHonestAbort({ userPrompt: "explain recursion", webResearchCalls: 1, traces: [{ tool: "search_web", result: "" }] }),
    false
  );
});

test("honest abort applies to meta-challenge follow-up via prior prompt", () => {
  assert.equal(
    shouldInjectHonestAbort({
      userPrompt: "Did you actually look up the weather?",
      priorUserPrompt: "What's the weather today in Spanish Fort AL",
      webResearchCalls: 1,
      traces: [{ tool: "search_web", result: "No results found." }]
    }),
    true
  );
});
