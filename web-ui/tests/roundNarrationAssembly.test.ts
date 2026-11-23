import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "../app/api/chat/route";
import { ThreadStore } from "../lib/threads/threadStore";
import { appendNarrationChunk, joinRoundNarrationSegments } from "../lib/liveActivity";
import { buildActivityTimeline } from "../lib/activityTimeline";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { ChatMessageItem } from "../components/chat/messageRender";
import { CanvasProvider } from "../components/CanvasContext";

describe("Fix 2 (U1) — Clean round narration and separated final summary", () => {
  let tmpThreadsDir: string;
  let origThreadsDir: string | undefined;
  let origLlmBaseUrl: string | undefined;
  let origLlmProvider: string | undefined;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;
  let server: http.Server | null = null;

  beforeEach(() => {
    tmpThreadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter3-narration-"));
    origThreadsDir = process.env.THREADS_DIR;
    origLlmBaseUrl = process.env.LLM_BASE_URL;
    origLlmProvider = process.env.LLM_ENGINE;
    origMcpUrl = process.env.MCP_SERVER_URL;
    origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59997/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59996/browser/sse";
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
    else process.env.THREADS_DIR = origThreadsDir;
    if (origLlmBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = origLlmBaseUrl;
    if (origLlmProvider === undefined) delete process.env.LLM_ENGINE;
    else process.env.LLM_ENGINE = origLlmProvider;
    if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = origMcpUrl;
    if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
    else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("appendNarrationChunk inserts unconditional \\n\\n at round boundaries and prevents 'patch:Now' / 'file:Host' joins", () => {
    // Unconditional round boundary join regardless of trailing character
    const joinedColon = appendNarrationChunk("Let me apply the patch:", "Now running tests.", {
      roundBoundary: true,
    });
    assert.equal(joinedColon, "Let me apply the patch:\n\nNow running tests.");
    assert.ok(!joinedColon.includes("patch:Now"));

    const joinedBacktick = appendNarrationChunk("Inspecting `route.ts`", "Host checks pass.", {
      roundBoundary: true,
    });
    assert.equal(joinedBacktick, "Inspecting `route.ts`\n\nHost checks pass.");

    // Even without explicit roundBoundary flag, colon + uppercase separates cleanly with \n\n
    const colonFallback = appendNarrationChunk("Reading file:", "Host returned 200.");
    assert.equal(colonFallback, "Reading file:\n\nHost returned 200.");
    assert.ok(!colonFallback.includes("file:Host"));

    // Mid-word BPE tokens still join seamlessly
    assert.equal(appendNarrationChunk("hel", "lo"), "hello");
    assert.equal(appendNarrationChunk("hello", " world"), "hello world");

    // Helper for assembling multiple round segments always uses \n\n
    const assembled = joinRoundNarrationSegments([
      "Let me apply the patch:",
      "Now checking the file:",
      "Host tests are green.",
    ]);
    assert.equal(
      assembled,
      "Let me apply the patch:\n\nNow checking the file:\n\nHost tests are green."
    );
  });

  it("(d) multi-round turn persists intermediate commentary in roundNarrations with \\n\\n boundaries and keeps final summary alone in content", async () => {
    let round = 0;
    server = http.createServer((_req, res) => {
      round += 1;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (round === 1) {
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "Let me apply the patch:",
              tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 10,
            eval_count: 5,
          })}\n`
        );
      } else if (round === 2) {
        res.write(
          `${JSON.stringify({
            message: {
              role: "assistant",
              content: "Now inspecting the file:",
              tool_calls: [{ function: { name: "workspace_get_tree", arguments: {} } }],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 5,
          })}\n`
        );
      } else {
        res.write(
          `${JSON.stringify({
            message: { role: "assistant", content: "All checks passed cleanly." },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 15,
            eval_count: 6,
          })}\n`
        );
      }
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    process.env.LLM_BASE_URL = `http://127.0.0.1:${addr.port}`;

    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "iter3-narration-thread",
        messages: [{ role: "user", content: "Apply patch and verify" }],
      }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const sseBody = await res.text();

    const store = new ThreadStore(tmpThreadsDir);
    const thread = await store.getThread("iter3-narration-thread");
    const assistant = thread?.messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "Assistant message must be persisted");

    // Summary block contains ONLY the model's closing words — no intermediate-round text glued on
    assert.equal(
      assistant.content.trim(),
      "All checks passed cleanly.",
      `Final summary must contain no intermediate-round text, got: ${JSON.stringify(assistant.content)}`
    );
    assert.ok(!assistant.content.includes("Let me apply the patch:"));
    assert.ok(!assistant.content.includes("Now inspecting the file:"));

    // Per-round commentary is preserved separately attached to its round
    assert.ok(Array.isArray(assistant.roundNarrations), "roundNarrations must be persisted");
    assert.equal(assistant.roundNarrations.length, 2);
    assert.deepEqual(assistant.roundNarrations[0], { round: 1, text: "Let me apply the patch:" });
    assert.deepEqual(assistant.roundNarrations[1], { round: 2, text: "Now inspecting the file:" });

    // Assembled narration across rounds has unconditional \n\n at every round boundary
    const assembled = joinRoundNarrationSegments(assistant.roundNarrations.map((r) => r.text));
    assert.equal(assembled, "Let me apply the patch:\n\nNow inspecting the file:");
    assert.ok(!assembled.includes("patch:Now"));

    // SSE done payload carries roundNarrations and clean final content
    const doneLine = sseBody
      .split("\n\n")
      .map((b) => b.trim())
      .filter((b) => b.startsWith("data:"))
      .map((b) => JSON.parse(b.replace(/^data:\s*/, "")))
      .find((ev) => ev.type === "done");
    assert.ok(doneLine, "SSE done event must be present");
    assert.equal(doneLine.content.trim(), "All checks passed cleanly.");
    assert.equal(doneLine.roundNarrations.length, 2);
  });

  it("ActivityTimeline renders per-round commentary attached to its round, separate from the summary block", () => {
    const traces = [
      {
        tool: "workspace_read_file",
        args: { path: "src/foo.ts" },
        result: "ok",
        durationMs: 10,
        round: 1,
      },
      {
        tool: "workspace_run_command",
        args: { command: "npm test" },
        result: "ok",
        durationMs: 25,
        round: 2,
      },
    ];
    const roundNarrations = [
      { round: 1, text: "Let me apply the patch:" },
      { round: 2, text: "Now running the test suite." },
    ];

    const rows = buildActivityTimeline(traces, undefined, { roundNarrations });
    const narrationRows = rows.filter((r) => r.kind === "narration");
    assert.equal(narrationRows.length, 2);
    assert.equal(narrationRows[0].round, 1);
    assert.equal(narrationRows[1].round, 2);
    // Narration for round 1 precedes round 1's trace; round 2 precedes round 2's trace
    const r1NarIdx = rows.findIndex((r) => r.kind === "narration" && r.round === 1);
    const r1TraceIdx = rows.findIndex((r) => r.kind === "read");
    const r2NarIdx = rows.findIndex((r) => r.kind === "narration" && r.round === 2);
    const r2TraceIdx = rows.findIndex((r) => r.kind === "shell");
    assert.ok(r1NarIdx < r1TraceIdx && r1TraceIdx < r2NarIdx && r2NarIdx < r2TraceIdx);

    const timelineHtml = renderToString(
      React.createElement(ActivityTimeline, {
        traces,
        roundNarrations,
      })
    );
    assert.ok(timelineHtml.includes('data-testid="timeline-round-narration"'));
    assert.ok(timelineHtml.includes("Let me apply the patch:"));
    assert.ok(timelineHtml.includes("Now running the test suite."));

    // Full message render keeps summary block strictly separate from intermediate narration
    const msgHtml = renderToString(
      React.createElement(
        CanvasProvider,
        null,
        React.createElement(ChatMessageItem, {
          message: {
            id: "a1",
            role: "assistant",
            content: "Final summary alone.",
            traces: traces as unknown as NonNullable<
              React.ComponentProps<typeof ChatMessageItem>["message"]["traces"]
            >,
            roundNarrations,
            status: "completed",
          },
          idx: 0,
          copiedMessageId: null,
          lastLinkedTaskMsgIndex: -1,
          lastAssistantIndex: 0,
          liveTurnTraces: [],
          isLoading: false,
          isStoppingTask: false,
          activeAssistantMsgId: null,
          completedTurnMsgId: null,
          streamStatus: null,
          turnStartedAtMs: null,
          lastActivityAtMs: Date.now(),
          expandedTraces: {},
          expandedProofs: {},
          hasResolvedDetachedTurn: false,
          activeModel: "test-model",
          onPreviewImage: () => {},
          onCopyToClipboard: () => {},
          onRetry: () => {},
          onToggleProof: () => {},
          onToggleTraces: () => {},
          onRunControlAction: () => {},
        })
      )
    );
    assert.ok(msgHtml.includes('data-testid="assistant-summary-content"'));
    const summaryStart = msgHtml.indexOf('data-testid="assistant-summary-content"');
    const summarySlice = msgHtml.slice(summaryStart, summaryStart + 500);
    assert.ok(summarySlice.includes("Final summary alone."));
    assert.ok(
      !summarySlice.includes("Let me apply the patch:"),
      "Summary block must contain no intermediate-round text"
    );
  });
});
