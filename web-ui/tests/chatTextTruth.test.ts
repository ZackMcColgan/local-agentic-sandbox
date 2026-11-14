import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatStream } from "../components/ChatStream";

function renderAssistantContent(content: string): string {
  return renderToStaticMarkup(
    React.createElement(ChatStream, {
      messages: [
        {
          id: "a-1",
          role: "assistant",
          content,
          createdAt: new Date().toISOString()
        }
      ],
      isLoading: false
    } as any)
  );
}

describe("Lane A Item 2: Assistant markdown standalone numbered answer", () => {
  it("preserves the written number for a standalone leading numbered answer instead of renumbering to 1", () => {
    const html = renderAssistantContent("42.");
    assert.ok(
      html.includes('start="42"') || !html.includes("<ol"),
      `Expected standalone '42.' to preserve number 42, got: ${html.slice(0, 500)}`
    );
  });

  it("renders a genuine multi-item numbered list starting at its real first number", () => {
    const html = renderAssistantContent("3. Third item\n4. Fourth item");
    assert.ok(html.includes("<ol"), "Expected <ol> for multi-item numbered list");
    assert.ok(
      html.includes('start="3"'),
      `Expected <ol start="3"> for list starting at 3, got: ${html.slice(0, 500)}`
    );
    assert.ok(html.includes("Third item") && html.includes("Fourth item"));
  });
});

describe("Lane A Item 3: User message bubble line breaks", () => {
  it("preserves single line breaks in a multi-line user message bubble", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatStream, {
        messages: [
          {
            id: "u-1",
            role: "user",
            content: "First line\nSecond line\nThird line",
            createdAt: new Date().toISOString()
          }
        ],
        isLoading: false
      } as any)
    );
    assert.ok(
      html.includes("whitespace-pre-line") || html.includes("<br"),
      `Expected user message bubble to preserve single line breaks, got: ${html.slice(0, 500)}`
    );
  });
});

