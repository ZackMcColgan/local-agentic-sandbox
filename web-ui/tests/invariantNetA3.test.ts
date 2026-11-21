import test from "node:test";
import assert from "node:assert/strict";
import {
  containsToolCallMarkup,
  isMarkupOnlyToolCall,
  evaluateMarkupRound,
} from "../lib/toolCallIntegrity";

interface VariantRow {
  name: string;
  roundContent: string;
  executedToolCallsCount: number;
  expectedAction: "pass" | "reprompt";
  expectedMarkupOnly?: boolean;
}

const VARIANT_TABLE: VariantRow[] = [
  // Positive cases: must be treated as failed/markup round
  {
    name: "Qwen <tool_call> JSON",
    roundContent: '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
    expectedMarkupOnly: true,
  },
  {
    name: "XML <function=...> dialect",
    roundContent: "<function=read_file><parameter=path>a.ts</parameter></function>",
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
  },
  {
    name: "DeepSeek <|tool_call|> dialect",
    roundContent: "<|tool_calls_section_begin|><|tool_call|>read_file",
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
  },
  {
    name: "UI-086 hybrid (<tool_call> + <|im_start|> + function_calls> + <parameter=arguments>)",
    roundContent:
      '<tool_call><|im_start|>function_calls><invoke name="run_command"><parameter=arguments>{"cmd":"ls"}</parameter></invoke>',
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
    expectedMarkupOnly: true,
  },
  {
    name: "Unclosed <tool_call>",
    roundContent: '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}',
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
    expectedMarkupOnly: true,
  },
  {
    name: "<parameter= without closing tag",
    roundContent: '<parameter=arguments>{"cmd":"echo hi"}',
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
  },
  {
    name: "Markup split across lines",
    roundContent: '<tool_call>\n{\n  "name": "read_file",\n  "arguments": {}\n}\n</tool_call>',
    executedToolCallsCount: 0,
    expectedAction: "reprompt",
    expectedMarkupOnly: true,
  },

  // Negative cases: must NOT be flagged
  {
    name: "Ordinary prose containing the word tool_call",
    roundContent: "The model emitted a tool_call in the previous step, which is now complete.",
    executedToolCallsCount: 0,
    expectedAction: "pass",
    expectedMarkupOnly: false,
  },
  {
    name: "Real executed tool round (executedToolCallsCount > 0)",
    roundContent: '<tool_call>{"name":"read_file"}</tool_call>',
    executedToolCallsCount: 1,
    expectedAction: "pass",
  },
  {
    name: "Normal assistant message mentioning markup inside fenced code block (isMarkupOnlyToolCall = false)",
    roundContent: "Here is an example of the tag:\n```xml\n<tool_call>example</tool_call>\n```",
    executedToolCallsCount: 0,
    expectedAction: "reprompt", // containsToolCallMarkup detects raw tag; isMarkupOnlyToolCall is false
    expectedMarkupOnly: false,
  },
];

for (const row of VARIANT_TABLE) {
  test(`Phase A3 — ${row.name}`, () => {
    const res = evaluateMarkupRound({
      roundContent: row.roundContent,
      executedToolCallsCount: row.executedToolCallsCount,
      consecutiveMarkupFailures: 0,
    });
    assert.equal(
      res.action,
      row.expectedAction,
      `evaluateMarkupRound action mismatch for: ${row.name}`
    );
    if (row.expectedMarkupOnly !== undefined) {
      assert.equal(
        isMarkupOnlyToolCall(row.roundContent),
        row.expectedMarkupOnly,
        `isMarkupOnlyToolCall mismatch for: ${row.name}`
      );
    }
  });
}

test("Phase A3 — containsToolCallMarkup returns false for empty string and plain prose", () => {
  assert.equal(containsToolCallMarkup(""), false);
  assert.equal(
    containsToolCallMarkup("Plain prose mentioning tool_call without angle brackets."),
    false
  );
});
