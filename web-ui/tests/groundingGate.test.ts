import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSearchQuery,
  hasSubstantiveWebResults,
  isMetaChallenge,
  shouldInjectHonestAbort,
  HONEST_ABORT_DIRECTIVE
} from "../lib/grounding";

test("deriveSearchQuery strips artifact/instruction wrappers", () => {
  const q = deriveSearchQuery("Create a svg of the weather today in Spanish Fort AL");
  assert.match(q, /weather/i);
  assert.match(q, /Spanish Fort/);
  assert.doesNotMatch(q, /svg/i);
  assert.doesNotMatch(q, /create/i);
});

test("deriveSearchQuery strips politeness and chart wrappers", () => {
  const q = deriveSearchQuery("Can you please make a chart of the bitcoin price today?");
  assert.match(q, /bitcoin price/i);
  assert.doesNotMatch(q, /chart|can you|please/i);
});

test("deriveSearchQuery uses prior prompt for meta-challenges", () => {
  assert.equal(isMetaChallenge("Did you actually look up the weather?"), true);
  const q = deriveSearchQuery(
    "Did you actually look up the weather?",
    "Create a svg of the weather today in Spanish Fort AL"
  );
  assert.match(q, /weather/i);
  assert.match(q, /Spanish Fort/);
  assert.doesNotMatch(q, /did you|actually|svg/i);
});

test("deriveSearchQuery meta-challenge without prior still strips challenge", () => {
  const q = deriveSearchQuery("Did you actually look up the weather?");
  assert.match(q, /weather/i);
  assert.doesNotMatch(q, /did you|actually|look up/i);
});

test("deriveSearchQuery never returns empty", () => {
  assert.ok(deriveSearchQuery("please").length > 0);
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
  const traces = [{ tool: "search_web", args: { query: "Create a svg of the weather today in Spanish Fort AL" }, result: { results: [] } }];
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
