import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatChatErrorMessage } from "../lib/chatUtils";

test("formatChatErrorMessage handles plain text, JSON errors, and prefixed engine errors", () => {
  // 1. Plain text error
  const plain = formatChatErrorMessage("Network timeout connecting to Ollama");
  assert.equal(plain.summary, "Network timeout connecting to Ollama");
  assert.equal(plain.details, undefined);

  // 2. Pure JSON with nested error.message
  const jsonNested = formatChatErrorMessage(
    JSON.stringify({
      error: {
        message: "Failed to allocate KV cache",
        type: "server_error",
        code: 500
      }
    })
  );
  assert.equal(jsonNested.summary, "Failed to allocate KV cache");
  assert.ok(jsonNested.details);
  assert.ok(jsonNested.details.includes("Failed to allocate KV cache"));

  // 3. Engine prefix with embedded JSON
  const prefixed = formatChatErrorMessage(
    'llama.cpp engine returned 500: {"error":{"message":"Slot out of memory","code":500}}'
  );
  assert.equal(prefixed.summary, "llama.cpp engine returned 500: Slot out of memory");
  assert.ok(prefixed.details);
  assert.ok(prefixed.details.includes("Slot out of memory"));

  // 4. Flat JSON with error string
  const jsonFlat = formatChatErrorMessage(
    JSON.stringify({ error: "Context limit exceeded" })
  );
  assert.equal(jsonFlat.summary, "Context limit exceeded");
  assert.ok(jsonFlat.details);

  // 5. Flat JSON with message string
  const jsonMessage = formatChatErrorMessage(
    JSON.stringify({ message: "Engine unavailable" })
  );
  assert.equal(jsonMessage.summary, "Engine unavailable");
  assert.ok(jsonMessage.details);

  // 6. Error instance
  const errInstance = formatChatErrorMessage(new Error("Connection refused"));
  assert.equal(errInstance.summary, "Connection refused");
});

test("ChatStream.tsx implements 390px mobile header, trace collapsing, error card, and composer styles", () => {
  const filePath = path.resolve(__dirname, "../components/ChatStream.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  // Top header: threadTitle is hidden on mobile (<768px) to prevent squishing
  assert.ok(
    content.includes("hidden md:block") && content.includes("threadTitle"),
    "ChatStream top header must hide thread title on mobile (< md:)"
  );

  // Header buttons have responsive labels
  assert.ok(
    content.includes('<span className="hidden sm:inline">Workspace</span>') ||
    content.includes("hidden sm:inline") && content.includes("Workspace"),
    "Workspace toggle label must be hidden on mobile (< sm:)"
  );

  // Tool trace list collapsing when traces > 3
  assert.ok(
    content.includes("Show all ") && content.includes("tool steps"),
    "ChatStream must support collapsing tool trace cards when > 3 steps exist"
  );
  assert.ok(
    content.includes("Collapse tool steps"),
    "ChatStream must support toggling back to collapsed state"
  );

  // Engine error card with formatChatErrorMessage and Retry button
  assert.ok(
    content.includes("formatChatErrorMessage"),
    "ChatStream must format errors with formatChatErrorMessage"
  );
  assert.ok(
    content.includes("Retry") && (content.includes("handleRetry") || content.includes("onRetry")),
    "ChatStream error card must contain a Retry button"
  );
  assert.ok(
    content.includes("Technical details"),
    "ChatStream error card must contain collapsible Technical details"
  );

  // Mobile composer: textarea text-[15px] and min-h-[46px]
  assert.ok(
    content.includes("text-[15px] sm:text-sm"),
    "ChatStream composer textarea must use text-[15px] on mobile to prevent iOS auto-zoom"
  );
  assert.ok(
    content.includes("min-h-[46px] sm:min-h-"),
    "ChatStream composer textarea must use min-h-[46px] on mobile"
  );
});

test("ThinkingPanel.tsx implements mobile compact badge and generous touch padding", () => {
  const filePath = path.resolve(__dirname, "../components/ThinkingPanel.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  // Generous touch padding for mobile reasoning bar
  assert.ok(
    content.includes("px-3.5 py-2.5 sm:px-4 sm:py-3") || content.includes("sm:py-3"),
    "ThinkingPanel toggle bar must have generous touch padding"
  );

  // Badge text hides verbose 'Thought process · ' on mobile
  assert.ok(
    content.includes("hidden sm:inline") && (content.includes("Thought process") || content.includes("Streaming")),
    "ThinkingPanel badge text must collapse verbose prefix on mobile"
  );
});

test("SvgViewer.tsx implements mobile-safe flex-wrap toolbar", () => {
  const filePath = path.resolve(__dirname, "../components/SvgViewer.tsx");
  const content = fs.readFileSync(filePath, "utf-8");

  // Header toolbar wrapping and padding
  assert.ok(
    content.includes("flex-wrap") && (content.includes("py-2.5 sm:px-4") || content.includes("px-3 py-2.5")),
    "SvgViewer header toolbar must support flex-wrap and responsive padding"
  );
});

test("ChatStream.tsx and page.tsx prevent thread auto-creation race condition from clobbering in-flight assistant stream", () => {
  const chatStreamPath = path.resolve(__dirname, "../components/ChatStream.tsx");
  const chatStreamContent = fs.readFileSync(chatStreamPath, "utf-8");

  // 1. ChatStream defines/uses upsertAssistant (or prev.some(msg => msg.id === assistantMsgId)) for in-flight resilience
  assert.ok(
    chatStreamContent.includes("upsertAssistant") &&
    (chatStreamContent.includes("exists") || chatStreamContent.includes("prev.some")),
    "ChatStream upsertAssistant must verify existence and re-insert assistant message if wiped"
  );

  // 2. ChatStream does NOT unconditionally treat activeTask && i === deduplicatedMessages.length - 1 as lastLinkedTaskMsgIndex
  assert.ok(
    !chatStreamContent.includes("activeTask && i === deduplicatedMessages.length - 1"),
    "ChatStream must not unconditionally mark the last message of any thread as a task host"
  );
  assert.ok(
    chatStreamContent.includes("lastLinkedTaskMsgIndex = deduplicatedMessages") &&
    chatStreamContent.includes("m.taskId ? i : -1"),
    "ChatStream lastLinkedTaskMsgIndex must only map messages with explicit m.taskId"
  );

  // 3. page.tsx tracks auto-created threads using skipThreadLoadRef and resets activeTask on thread creation
  const pagePath = path.resolve(__dirname, "../app/page.tsx");
  const pageContent = fs.readFileSync(pagePath, "utf-8");

  assert.ok(
    pageContent.includes("skipThreadLoadRef"),
    "page.tsx must define skipThreadLoadRef to prevent concurrent thread loads from wiping in-flight streams"
  );
  assert.ok(
    pageContent.includes("skipThreadLoadRef.current = data.thread.id") ||
    pageContent.includes("skipThreadLoadRef.current = "),
    "page.tsx handleEnsureThread must set skipThreadLoadRef when creating a thread"
  );
  assert.ok(
    pageContent.includes("setActiveTask(null)") && pageContent.includes("handleEnsureThread"),
    "page.tsx handleEnsureThread must reset activeTask to null"
  );
  assert.ok(
    pageContent.includes("skipThreadLoadRef.current === selectedThreadId"),
    "page.tsx useEffect([selectedThreadId]) must bypass loadSelectedThread when skipThreadLoadRef matches"
  );
});

