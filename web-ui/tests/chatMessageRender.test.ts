import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessageContent, ChatMessageItem } from "../components/chat/messageRender";
import type { ChatMessage } from "../components/ChatStream";

function noop() {}

function baseProps(message: ChatMessage) {
  return {
    message,
    idx: 0,
    copiedMessageId: null,
    lastLinkedTaskMsgIndex: -1,
    lastAssistantIndex: 0,
    activeTask: null,
    liveTraces: [],
    liveTurnTraces: [],
    isLoading: false,
    isStoppingTask: false,
    activeAssistantMsgId: null,
    completedTurnMsgId: null,
    streamStatus: null,
    turnStartedAtMs: null,
    lastActivityAtMs: 0,
    expandedTraces: {},
    expandedProofs: {},
    hasResolvedDetachedTurn: false,
    activeModel: "test-model",
    onPreviewImage: noop,
    onCopyToClipboard: noop,
    onRetry: noop,
    onToggleProof: noop,
    onToggleTraces: noop,
    onRunControlAction: noop,
  };
}

describe("chat/messageRender presentational components", () => {
  it("UserMessageContent renders short prompt without collapse toggle", () => {
    const html = renderToStaticMarkup(React.createElement(UserMessageContent, { content: "Short prompt" }));
    assert.ok(html.includes("Short prompt"));
    assert.ok(!html.includes("brief-collapse-toggle"));
  });

  it("UserMessageContent collapses long prompts behind Show full brief toggle", () => {
    const longText = "a".repeat(400);
    const html = renderToStaticMarkup(React.createElement(UserMessageContent, { content: longText }));
    assert.ok(html.includes('data-testid="brief-collapse-toggle"'));
    assert.ok(html.includes("Show full brief"));
  });

  it("ChatMessageItem renders user bubble with copy button", () => {
    const msg: ChatMessage = { id: "u1", role: "user", content: "Hello world" };
    const html = renderToStaticMarkup(React.createElement(ChatMessageItem, baseProps(msg)));
    assert.ok(html.includes("Hello world"));
    assert.ok(html.includes('data-testid="copy-user-message-btn"'));
  });

  it("ChatMessageItem renders assistant bubble with copy response button and stopped pill", () => {
    const msg: ChatMessage = {
      id: "a1",
      role: "assistant",
      content: "Done.",
      isStopped: true,
    };
    const html = renderToStaticMarkup(React.createElement(ChatMessageItem, baseProps(msg)));
    assert.ok(html.includes("Done."));
    assert.ok(html.includes('data-testid="copy-response-btn"'));
    assert.ok(html.includes("• Stopped"));
  });
});
