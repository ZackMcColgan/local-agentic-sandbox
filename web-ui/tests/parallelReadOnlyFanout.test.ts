import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOL_FANOUT_CAP,
  isReadOnlyFanoutTool,
  partitionToolCallBatches,
} from "../lib/chat/toolFanout";
import { runChatTurn, type RunChatTurnDeps, type RunChatTurnState } from "../lib/chat/roundLoop";
import { createSseEventWriter } from "../lib/chat/turnEngine";
import { ThreadStore } from "../lib/threads/threadStore";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { TelemetryTracer } from "../lib/telemetry";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { QueuedJob } from "../lib/jobQueue";

/**
 * Board #125 (Perf P2) contract tests: the model is allowed to emit multiple
 * tool calls per round (parallel_tool_calls = true at the provider), and the
 * runaway-loop protection lives entirely inside the fanout partition machinery
 * (TOOL_FANOUT_CAP, read-only allowlist, writes as strict sequential barriers).
 */

describe("Partition contract: mixed read/write blocks keep writes strictly sequential", () => {
  it("3 reads + 1 write + 2 reads partitions into [parallel 3][barrier write][parallel 2]", () => {
    const calls = [
      { name: "workspace_read_file", id: "r0" },
      { name: "workspace_grep", id: "r1" },
      { name: "host_read_file", id: "r2" },
      { name: "workspace_write_file", id: "w3" },
      { name: "workspace_get_tree", id: "r4" },
      { name: "workspace_read_file", id: "r5" },
    ];
    const batches = partitionToolCallBatches(calls, (c) => isReadOnlyFanoutTool(c.name));

    assert.equal(batches.length, 3, "expected exactly 3 batches: reads, write barrier, reads");
    assert.equal(batches[0].kind, "parallel");
    assert.deepEqual(
      batches[0].kind === "parallel" ? batches[0].items.map((x) => x.index) : [],
      [0, 1, 2]
    );
    assert.equal(batches[1].kind, "barrier");
    assert.equal(batches[1].kind === "barrier" ? batches[1].item.name : "", "workspace_write_file");
    assert.equal(batches[1].kind === "barrier" ? batches[1].index : -1, 3);
    assert.equal(batches[2].kind, "parallel");
    assert.deepEqual(
      batches[2].kind === "parallel" ? batches[2].items.map((x) => x.index) : [],
      [4, 5]
    );

    // The write barrier batch never contains any other call.
    for (const batch of batches) {
      if (batch.kind === "barrier") continue;
      for (const item of batch.items) {
        assert.notEqual(item.item.name, "workspace_write_file", "write must never be concurrent");
        assert.ok(isReadOnlyFanoutTool(item.item.name), "parallel batches are read-only only");
      }
    }
  });

  it("read runs longer than TOOL_FANOUT_CAP still partition as one eligible batch bounded by the cap", () => {
    const calls = Array.from({ length: TOOL_FANOUT_CAP + 4 }, (_, i) => ({
      name: "workspace_read_file",
      id: `r${i}`,
    }));
    const batches = partitionToolCallBatches(calls, (c) => isReadOnlyFanoutTool(c.name));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].kind, "parallel");
    assert.equal(
      batches[0].kind === "parallel" ? batches[0].items.length : 0,
      TOOL_FANOUT_CAP + 4,
      "partition preserves emission order; the concurrency cap is enforced at execution time"
    );
  });
});

describe("Round contract: multiple read-only calls execute in ONE round", () => {
  let tmpDir: string;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-ro-round-"));
    origMcpUrl = process.env.MCP_SERVER_URL;
    origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59993/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59994/browser/sse";
  });

  after(() => {
    if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = origMcpUrl;
    if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
    else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a model response emitting 3 read-only calls produces 3 traces in a single round", async () => {
    const threadStore = new ThreadStore(tmpDir);
    const threadId = `parallel-ro-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const thread = threadStore.createThread({ id: threadId, title: "parallel round test" });

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const reqAbort = new AbortController();
    const baseWriter = createSseEventWriter({
      stream,
      signal: reqAbort.signal,
      activeThreadId: thread.id,
    });
    baseWriter.startReadableDrain();

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

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      [
        "workspace_read_file",
        {
          client: {
            callTool: async (req: { name: string; arguments: Record<string, unknown> }) => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ content: `1 | body of ${req.arguments.path}` }),
                },
              ],
            }),
            close: async () => {},
          } as unknown as Client,
          tier: "sandbox",
        },
      ],
    ]);

    let llmRound = 0;
    const deps: RunChatTurnDeps = {
      reqSignal: reqAbort.signal,
      messages: [{ role: "user", content: "Read three files." }],
      userPrompt: "Read three files.",
      priorUserPrompt: "",
      assistantMessageId: "msg-parallel-ro",
      clientSessionId: "sess-parallel-ro",
      systemPrompt: "You are a test agent.",
      effortDirective: "",
      imagePayloads: [],
      docContexts: [],
      mode: "auto",
      requestedModel: "test-model",
      initialEffectiveReasoningEffort: "low",
      invalidRequestedModel: null,
      triageComplexityResult: null,
      getLlmBaseUrl: () => "http://127.0.0.1:59995",
      resolveJobRepoRoot: () => tmpDir,
      streamLlmChat: async function* () {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "p0",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "a.ts" }),
                  },
                },
                {
                  id: "p1",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "b.ts" }),
                  },
                },
                {
                  id: "p2",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "c.ts" }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          yield { message: { content: "All three read in one round." }, finish_reason: "stop" };
        }
      },
      advertisedTools: new Set(toolClientMap.keys()),
      activeThreadId: thread.id,
      threadsDir: tmpDir,
      threadStore,
      initialThreadData: thread,
      initialThreadHostAccess: false,
      streamSnapshot: new ThrottledStreamSnapshot(threadStore, thread.id, "msg-parallel-ro"),
      sseWriter: baseWriter,
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
      id: "job-parallel-ro",
      threadId: thread.id,
      prompt: "Read three files.",
      position: 0,
      status: "running",
    };

    await runChatTurn(deps, fakeJob, null);

    assert.equal(
      llmRound,
      2,
      "the 3 read-only calls must be dispatched inside round 1; only one follow-up round for the final answer"
    );
    assert.equal(turnState.traces.length, 3, "all 3 calls must record traces in the same round");
    assert.deepEqual(
      turnState.traces.map((t) => t.args.path),
      ["a.ts", "b.ts", "c.ts"],
      "traces must be committed in emission order"
    );
  });
});
