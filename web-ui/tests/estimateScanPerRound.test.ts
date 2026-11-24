import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  runChatToolLoop,
  setEstimateTokensObserver,
  estimateTokens,
  type ContextMessage,
  type FittedMessages,
} from "../lib/contextBudget";
import { runChatTurn, type RunChatTurnDeps, type RunChatTurnState } from "../lib/chat/roundLoop";
import { createSseEventWriter } from "../lib/chat/turnEngine";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { TelemetryTracer } from "../lib/telemetry";
import {
  ThreadStore,
  activeExecutionSet,
  markTurnActive,
  clearTurnActive,
} from "../lib/threads/threadStore";
import type { QueuedJob } from "../lib/jobQueue";

/**
 * Board #130 (Perf P6): the per-round prompt estimate must be measured ONCE and
 * threaded through the fit ladder, continuation check, and provider payload fit.
 *
 * The observer seam counts every estimateTokens() invocation whose input is an
 * ARRAY (a full-history scan). On the standard round path (no compaction, no
 * micro-elision, no artifact directives) the count must drop to at most 2 array
 * scans per round (one raw, one effective).
 */
function makeStandardHistory(): ContextMessage[] {
  return [
    { role: "system", content: "You are a helpful coding agent." },
    { role: "user", content: "Summarize the repo layout." },
  ];
}

function makeTools() {
  return [
    {
      type: "function",
      function: {
        name: "workspace_get_tree",
        description: "List directory tree.",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
}

describe("Board #130 — estimateTokens measured once per round (Perf P6)", () => {
  it("counts at most 2 full-history array scans per round on the standard path", async () => {
    let arrayScans = 0;
    setEstimateTokensObserver((input) => {
      if (Array.isArray(input)) arrayScans++;
    });

    try {
      let roundIndex = 0;
      const streamLlmChat = async function* (_payload: Record<string, unknown>) {
        roundIndex++;
        if (roundIndex === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "workspace_get_tree", arguments: "{}" },
                },
              ],
            },
          };
        } else {
          yield { message: { content: "The repo has web-ui and host-bridge." } };
        }
      };

      const result = await runChatToolLoop({
        conversationMessages: makeStandardHistory(),
        llmTools: makeTools(),
        streamLlmChat,
        executeTool: async () => ({ tree: "web-ui/\nhost-bridge/" }),
        maxToolRounds: 5,
      });

      assert.equal(result.roundsCompleted, 2, "two rounds executed");
      // At most 2 array scans per round (one raw, one effective).
      assert.ok(
        arrayScans <= 2 * result.roundsCompleted,
        `expected <= ${2 * result.roundsCompleted} array scans, got ${arrayScans}`
      );
    } finally {
      setEstimateTokensObserver(null);
    }
  });

  it("golden: estimator math unchanged — estimateTokens still ceil(len/4)", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(
      estimateTokens([{ role: "user", content: "hello world" }]),
      Math.ceil(("hello world".length + "user".length) / 4)
    );
  });

  it("runChatTurn multi-round append-only turn performs <= 1 raw message scan per round and <= 1 tool schema scan per turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf2-scan-"));
    const origThreadsDir = process.env.THREADS_DIR;
    const origMcpUrl = process.env.MCP_SERVER_URL;
    const origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    process.env.THREADS_DIR = dir;
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";

    const store = new ThreadStore(dir);
    const threadId = `t-pf2-${Date.now()}`;
    const thread = store.createThread({ id: threadId, title: "Scan per round test" });
    const totalRounds = 3;

    let llmRound = 0;
    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ content: `1 | ${String(req.arguments.path || "a.ts")}` }),
          },
        ],
      }),
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const reqAbort = new AbortController();
    const sseWriter = createSseEventWriter({
      stream,
      signal: reqAbort.signal,
      activeThreadId: thread.id,
    });
    sseWriter.startReadableDrain();

    const turnState: RunChatTurnState = {
      activeModel: "test-model",
      accumulatedStreamedTokens: "",
      assistantPersisted: false,
      lastFinishReason: undefined,
      turnOutputTokens: undefined,
      turnCreatedFiles: [],
      turnPreImages: new Map(),
      turnHostDiffs: [],
      traces: [],
      turnMicroElisions: [],
      turnReadDedups: [],
      accumulatedThoughts: [],
    };

    const deps: RunChatTurnDeps = {
      reqSignal: reqAbort.signal,
      messages: [{ role: "user", content: "Inspect two files and summarize." }],
      userPrompt: "Inspect two files and summarize.",
      priorUserPrompt: "",
      assistantMessageId: "msg-pf2",
      clientSessionId: "sess-pf2",
      systemPrompt: "You are a helpful coding assistant.",
      effortDirective: "",
      imagePayloads: [],
      docContexts: [],
      mode: "auto",
      requestedModel: "test-model",
      initialEffectiveReasoningEffort: "low",
      invalidRequestedModel: null,
      triageComplexityResult: null,
      getLlmBaseUrl: () => "http://127.0.0.1:59999",
      resolveJobRepoRoot: () => dir,
      streamLlmChat: async function* () {
        llmRound += 1;
        if (llmRound < totalRounds) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: `call_pf2_${llmRound}`,
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: `file-${llmRound}.ts` }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          yield {
            message: { content: "All 3 rounds complete." },
            finish_reason: "stop",
          };
        }
      },
      advertisedTools: new Set(["workspace_read_file"]),
      activeThreadId: thread.id,
      threadsDir: dir,
      threadStore: store,
      initialThreadData: thread,
      initialThreadHostAccess: false,
      streamSnapshot: new ThrottledStreamSnapshot(store, thread.id, "msg-pf2"),
      sseWriter,
      turnAbortController: new AbortController(),
      persistAssistantOnAbort: () => {},
      onRunTurnStarted: () => {},
      onRunTurnFinally: () => {},
      isExplicitStopped: () => false,
      turnState,
      activeSessions: [],
      toolClientMap,
      tracer: new TelemetryTracer(),
      rootSpan: null,
    };

    const fakeJob: QueuedJob = {
      id: "job-pf2",
      threadId: thread.id,
      prompt: "Inspect two files and summarize.",
      position: 0,
      status: "running",
    };

    let arrayScans = 0;
    let schemaStringifyScans = 0;
    setEstimateTokensObserver((input) => {
      if (Array.isArray(input)) {
        arrayScans++;
      } else if (typeof input === "string" && input.startsWith('[{"type":"function"')) {
        schemaStringifyScans++;
      }
    });

    try {
      activeExecutionSet.add(threadId);
      markTurnActive(threadId);
      await runChatTurn(deps, fakeJob, null);

      assert.equal(llmRound, totalRounds, "expected 3 LLM rounds to execute");
      assert.ok(
        arrayScans <= totalRounds,
        `expected <= ${totalRounds} raw conversationMessages scans (<= 1 per round), got ${arrayScans}`
      );
      assert.ok(
        schemaStringifyScans <= 1,
        `expected <= 1 estimateToolSchemaTokens scan across the turn, got ${schemaStringifyScans}`
      );
    } finally {
      setEstimateTokensObserver(null);
      clearTurnActive(threadId);
      activeExecutionSet.delete(threadId);
      if (origThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = origThreadsDir;
      if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
      else process.env.MCP_SERVER_URL = origMcpUrl;
      if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
      else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runChatToolLoop invalidates cached raw tokens after appendTrailingDirective so fitContextWindow sees updated tokens", async () => {
    const history: ContextMessage[] = [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "Create a standalone SVG diagram of the layout." },
      { role: "assistant", content: "Inspecting layout." },
      { role: "tool", name: "workspace_get_tree", content: "a".repeat(5800) },
    ];

    // Pre-directive tokens (~1490) sit below both compaction threshold (0.85 * 4500 = 3825)
    // and fitContextWindow artifact ceiling (4500 - 3000 = 1500), while appending
    // FINAL_ROUND_SYNTHESIS_DIRECTIVE + OUTPUT_HEADROOM_THINKING_DIRECTIVE pushes
    // the real count over 1500 so fitContextWindow must see updated tokens.
    const seenPayloads: Array<{ messages: FittedMessages; actualTokens: number }> = [];
    const streamLlmChat = async function* (payload: Record<string, unknown>) {
      const msgs = payload.messages as FittedMessages;
      seenPayloads.push({
        messages: msgs,
        actualTokens: estimateTokens(msgs),
      });
      yield { message: { content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } };
    };

    const result = await runChatToolLoop({
      conversationMessages: history,
      llmTools: [],
      streamLlmChat,
      executeTool: async () => ({}),
      maxToolRounds: 1,
      maxContentTokens: 4500,
    });

    assert.equal(result.roundsCompleted, 1);
    assert.equal(seenPayloads.length, 1);
    const firstPayload = seenPayloads[0];
    assert.equal(
      firstPayload.messages.estimatedTokens,
      firstPayload.actualTokens,
      `fitContextWindow must see updated post-directive tokens (reported=${firstPayload.messages.estimatedTokens}, actual=${firstPayload.actualTokens})`
    );
    assert.ok(
      (firstPayload.messages.evictedCount ?? 0) > 0,
      "fitContextWindow must evict non-protected messages once appended directives push tokens past maxContentTokens"
    );
  });
});
