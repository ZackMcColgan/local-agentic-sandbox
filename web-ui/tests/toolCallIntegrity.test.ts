import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  containsToolCallMarkup,
  isMarkupOnlyToolCall,
  evaluateMarkupRound,
  evaluateZeroTraceTripwire,
  TURN_TOOL_MARKUP_MARKER,
  TOOL_MARKUP_REPAIR_DIRECTIVE,
} from "../lib/toolCallIntegrity";

describe("tool-call-integrity: markup-in-content detector", () => {
  it("triggers exactly ONE repair re-prompt on first markup-as-text round, then honest end marker on second consecutive failure", () => {
    const markupText =
      '<tool_call><function=host_run_file_read>{"path":"foo.ts"}</function></tool_call>\nReading foo.ts...';

    assert.equal(containsToolCallMarkup(markupText), true);

    // First consecutive failure: reprompt once
    const first = evaluateMarkupRound({
      roundContent: markupText,
      executedToolCallsCount: 0,
      consecutiveMarkupFailures: 0,
    });
    assert.equal(first.action, "reprompt");
    assert.equal(first.consecutiveMarkupFailures, 1);
    assert.equal(first.directive, TOOL_MARKUP_REPAIR_DIRECTIVE);

    // Second consecutive failure: end turn honestly with marker
    const second = evaluateMarkupRound({
      roundContent: markupText,
      executedToolCallsCount: 0,
      consecutiveMarkupFailures: first.consecutiveMarkupFailures,
    });
    assert.equal(second.action, "end_turn");
    assert.equal(second.consecutiveMarkupFailures, 2);
    assert.equal(second.marker, TURN_TOOL_MARKUP_MARKER);
    assert.equal(second.marker, "⚠️ [Turn ended: tool calls were not executable.]");
  });

  it("detects <|im_start|>function_calls> and <parameter=...> hybrid dialect", () => {
    const fullHybrid = [
      "<tool_call>",
      "<|im_start|>function_calls>",
      "<parameter=arguments>",
      '{"command": "ls -la"}',
    ].join("\n");
    assert.equal(containsToolCallMarkup(fullHybrid), true);

    const withoutToolCallTag = [
      "<|im_start|>function_calls>",
      "<parameter=arguments>",
      '{"command": "ls -la"}',
    ].join("\n");
    assert.equal(containsToolCallMarkup(withoutToolCallTag), true);
    const evalResult = evaluateMarkupRound({
      roundContent: withoutToolCallTag,
      executedToolCallsCount: 0,
      consecutiveMarkupFailures: 0,
    });
    assert.equal(evalResult.action, "reprompt");

    assert.equal(containsToolCallMarkup("function_calls>\n<parameter=path>\nfoo.ts"), true);
    assert.equal(containsToolCallMarkup("<parameter=arguments>\n{}"), true);

    assert.equal(isMarkupOnlyToolCall(fullHybrid), true);
    assert.equal(isMarkupOnlyToolCall(withoutToolCallTag), true);
    assert.equal(isMarkupOnlyToolCall("Here is the result:\n<tool_call>...</tool_call>"), false);
  });

  it("leaves a normal tool round untouched when tool calls were parsed and executed", () => {
    const markupText = '<tool_call><function=host_run_file_read>{"path":"foo.ts"}</function></tool_call>';
    const result = evaluateMarkupRound({
      roundContent: markupText,
      executedToolCallsCount: 1,
      consecutiveMarkupFailures: 1,
    });
    assert.equal(result.action, "pass");
    assert.equal(result.consecutiveMarkupFailures, 0);
    assert.equal(result.marker, undefined);
  });
});

describe("tool-call-integrity: zero-trace tripwire", () => {
  it("stamps completed-unverified when a turn claims tool work with zero recorded traces", () => {
    const result = evaluateZeroTraceTripwire({
      content: "I ran `npm test` and edited `app/page.tsx` to fix the bug.",
      tracesCount: 0,
    });
    assert.equal(result.completionStamp, "completed-unverified");
    assert.ok(result.gaps.length > 0);
    assert.equal(result.gaps[0].kind, "zero_traces");
  });

  it("does not stamp unverified when traces are recorded or no tool work is claimed", () => {
    const withTraces = evaluateZeroTraceTripwire({
      content: "I ran `npm test` and edited `app/page.tsx`.",
      tracesCount: 2,
    });
    assert.equal(withTraces.completionStamp, undefined);

    const plainChat = evaluateZeroTraceTripwire({
      content: "Hello! How can I help you today?",
      tracesCount: 0,
    });
    assert.equal(plainChat.completionStamp, undefined);
  });
});
