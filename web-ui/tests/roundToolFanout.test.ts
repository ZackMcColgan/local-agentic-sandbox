import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  READ_ONLY_FANOUT_TOOLS,
  TOOL_FANOUT_CAP,
  isReadOnlyFanoutTool,
  partitionToolCallBatches,
  executeWithConcurrencyLimit,
} from "../lib/chat/toolFanout";
import { runChatTurn, type RunChatTurnDeps, type RunChatTurnState } from "../lib/chat/roundLoop";
import { createSseEventWriter } from "../lib/chat/turnEngine";
import { ThreadStore } from "../lib/threads/threadStore";
import { ThrottledStreamSnapshot } from "../lib/streamSnapshot";
import { TelemetryTracer } from "../lib/telemetry";
import { createHostServer } from "../../host-bridge/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { QueuedJob } from "../lib/jobQueue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTurnDeps(overrides: {
  tmpDir: string;
  toolClientMap: RunChatTurnDeps["toolClientMap"];
  streamLlmChat: RunChatTurnDeps["streamLlmChat"];
  hostAccess?: boolean;
  isProhibitedTask?: boolean;
  onEvent?: (evt: Record<string, unknown>) => void;
}) {
  const threadStore = new ThreadStore(overrides.tmpDir);
  const threadId = `fanout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const thread = threadStore.createThread({
    id: threadId,
    title: "fanout test",
    hostAccess: Boolean(overrides.hostAccess),
    ...(overrides.isProhibitedTask ? { taskId: "task-prohibited" } : {}),
  });

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const reqAbort = new AbortController();
  const baseWriter = createSseEventWriter({
    stream,
    signal: reqAbort.signal,
    activeThreadId: thread.id,
  });
  // Drain readable so SSE writer never blocks
  baseWriter.startReadableDrain();

  const events: Array<Record<string, unknown>> = [];
  const sseWriter = {
    ...baseWriter,
    sendEvent: async (data: Record<string, unknown>) => {
      events.push(data);
      overrides.onEvent?.(data);
      await baseWriter.sendEvent(data);
    },
  };

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

  const turnAbortController = new AbortController();
  const streamSnapshot = new ThrottledStreamSnapshot(threadStore, thread.id, "msg-fanout");
  const tracer = new TelemetryTracer();

  const deps: RunChatTurnDeps = {
    reqSignal: reqAbort.signal,
    messages: [{ role: "user", content: "Inspect repository files." }],
    userPrompt: "Inspect repository files.",
    priorUserPrompt: "",
    assistantMessageId: "msg-fanout",
    clientSessionId: "sess-fanout",
    systemPrompt: "You are a test agent.",
    effortDirective: "",
    imagePayloads: [],
    docContexts: [],
    mode: "auto",
    requestedModel: "test-model",
    initialEffectiveReasoningEffort: "low",
    invalidRequestedModel: null,
    triageComplexityResult: null,
    getLlmBaseUrl: () => "http://127.0.0.1:59999",
    resolveJobRepoRoot: () => overrides.tmpDir,
    streamLlmChat: overrides.streamLlmChat,
    advertisedTools: new Set(overrides.toolClientMap.keys()),
    activeThreadId: thread.id,
    threadsDir: overrides.tmpDir,
    threadStore,
    initialThreadData: thread,
    initialThreadHostAccess: Boolean(overrides.hostAccess),
    streamSnapshot,
    sseWriter,
    turnAbortController,
    persistAssistantOnAbort: () => {},
    onRunTurnStarted: () => {},
    onRunTurnFinally: () => {},
    isExplicitStopped: () => false,
    turnState,
    activeSessions: [],
    toolClientMap: overrides.toolClientMap,
    tracer,
    rootSpan: null,
  };

  const fakeJob: QueuedJob = {
    id: "job-fanout",
    threadId: thread.id,
    prompt: "Inspect repository files.",
    position: 0,
    status: "running",
  };

  return { deps, turnState, events, fakeJob, threadStore, threadId: thread.id };
}

describe("Part 2: toolFanout primitives & concurrency bounds", () => {
  it("exports TOOL_FANOUT_CAP = 8 and explicit READ_ONLY_FANOUT_TOOLS set", () => {
    assert.equal(TOOL_FANOUT_CAP, 8);
    for (const ro of [
      "host_read_file",
      "host_list_dir",
      "host_git_status",
      "host_git_pr_status",
      "workspace_read_file",
      "workspace_get_tree",
      "workspace_grep",
      "git_status",
      "git_diff",
      "verify_container_provenance",
      "docker_scout_policy_gate",
      "describe_tool",
    ]) {
      assert.equal(isReadOnlyFanoutTool(ro), true, `${ro} must be read-only`);
      assert.ok(READ_ONLY_FANOUT_TOOLS.has(ro));
    }

    for (const barrier of [
      "host_write_file",
      "host_replace_string",
      "host_delete_path",
      "host_run_powershell",
      "workspace_write_file",
      "workspace_patch_file",
      "workspace_run_command",
      "execute_sandboxed_python",
      "git_commit",
      "git_checkout_branch",
      "host_git_commit",
      "host_git_push",
      "search_web",
      "fetch_webpage_markdown",
    ]) {
      assert.equal(isReadOnlyFanoutTool(barrier), false, `${barrier} must be a barrier`);
    }
  });

  it("partitions contiguous read-only runs around barriers in emission order", () => {
    const calls = [
      { name: "workspace_read_file", id: "0" },
      { name: "workspace_grep", id: "1" },
      { name: "workspace_write_file", id: "2" },
      { name: "host_read_file", id: "3" },
      { name: "host_list_dir", id: "4" },
      { name: "host_delete_path", id: "5" },
    ];
    const batches = partitionToolCallBatches(calls, (c) => isReadOnlyFanoutTool(c.name));
    assert.equal(batches.length, 4);
    assert.equal(batches[0].kind, "parallel");
    assert.deepEqual(
      batches[0].kind === "parallel" ? batches[0].items.map((x) => x.index) : [],
      [0, 1]
    );
    assert.equal(batches[1].kind, "barrier");
    assert.equal(batches[1].kind === "barrier" ? batches[1].index : -1, 2);
    assert.equal(batches[2].kind, "parallel");
    assert.deepEqual(
      batches[2].kind === "parallel" ? batches[2].items.map((x) => x.index) : [],
      [3, 4]
    );
    assert.equal(batches[3].kind, "barrier");
    assert.equal(batches[3].kind === "barrier" ? batches[3].index : -1, 5);
  });

  it("enforces bounded fan-out cap (<= 8 in flight) across 12 concurrent items and preserves output order", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await executeWithConcurrencyLimit(items, TOOL_FANOUT_CAP, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Reverse latencies so later items finish earlier
      await sleep(30 + (12 - item) * 4);
      inFlight--;
      return `res-${item}`;
    });

    assert.ok(maxInFlight <= TOOL_FANOUT_CAP, `peak in-flight (${maxInFlight}) must be <= 8`);
    assert.ok(maxInFlight >= 4, `expected genuine concurrency (peak was ${maxInFlight})`);
    assert.deepEqual(
      results,
      items.map((i) => `res-${i}`),
      "results must stay in emission order"
    );
  });
});

describe("Part 2: roundLoop parallel tool fan-out integration", () => {
  let tmpDir: string;
  let origMcpUrl: string | undefined;
  let origBrowserMcpUrl: string | undefined;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roundloop-fanout-"));
    origMcpUrl = process.env.MCP_SERVER_URL;
    origBrowserMcpUrl = process.env.BROWSER_MCP_URL;
    // Point MCP servers to closed ports so connectMcpClient returns quickly without real servers
    process.env.MCP_SERVER_URL = "http://127.0.0.1:59991/mcp/sse";
    process.env.BROWSER_MCP_URL = "http://127.0.0.1:59992/browser/sse";
  });

  after(() => {
    if (origMcpUrl === undefined) delete process.env.MCP_SERVER_URL;
    else process.env.MCP_SERVER_URL = origMcpUrl;
    if (origBrowserMcpUrl === undefined) delete process.env.BROWSER_MCP_URL;
    else process.env.BROWSER_MCP_URL = origBrowserMcpUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Acceptance 1(c): 6 read-only calls with 100ms latencies complete well under 600ms and record traces in emission order", async () => {
    const completionOrder: string[] = [];
    let toolDispatchStart = 0;
    let toolDispatchEnd = 0;

    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        if (toolDispatchStart === 0) toolDispatchStart = performance.now();
        const filePath = String(req.arguments.path || "");
        const idx = Number(filePath.replace("file-", "").replace(".ts", "")) || 0;
        // Staggered >= 100ms latencies in reverse order: file-0 takes 150ms, file-5 takes 100ms
        await sleep(100 + (5 - idx) * 10);
        completionOrder.push(filePath);
        toolDispatchEnd = performance.now();
        return {
          content: [
            { type: "text", text: JSON.stringify({ content: `1 | content of ${filePath}` }) },
          ],
        };
      },
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    let llmRound = 0;
    const seenToolMessagesInRound2: Array<{ name?: string; content: string }> = [];

    const { deps, turnState, events, fakeJob } = makeTurnDeps({
      tmpDir,
      toolClientMap,
      streamLlmChat: async function* (_url, payload) {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: Array.from({ length: 6 }, (_, i) => ({
                id: `call_ro_${i}`,
                type: "function",
                function: {
                  name: "workspace_read_file",
                  arguments: JSON.stringify({ path: `file-${i}.ts` }),
                },
              })),
            },
            finish_reason: "stop",
          };
        } else {
          for (const m of payload.messages as Array<{
            role?: string;
            name?: string;
            content?: string;
          }>) {
            if (m.role === "tool") {
              seenToolMessagesInRound2.push({ name: m.name, content: String(m.content || "") });
            }
          }
          yield {
            message: { content: "All 6 files read concurrently." },
            finish_reason: "stop",
          };
        }
      },
    });

    await runChatTurn(deps, fakeJob, null);

    const dispatchMs = toolDispatchEnd - toolDispatchStart;
    assert.ok(
      dispatchMs < 450,
      `Expected 6x100ms read-only fan-out dispatch time well under 600ms, got ${Math.round(dispatchMs)}ms`
    );

    // Completion order was NOT emission order (file-5 finished before file-0)
    assert.notEqual(completionOrder[0], "file-0.ts");

    // Traces recorded in exact emission order (0..5)
    assert.equal(turnState.traces.length, 6);
    assert.deepEqual(
      turnState.traces.map((t) => t.args.path),
      ["file-0.ts", "file-1.ts", "file-2.ts", "file-3.ts", "file-4.ts", "file-5.ts"]
    );

    // SSE trace events also emitted in exact emission order
    const sseTracePaths = events
      .filter((e) => e.type === "trace")
      .map((e) => (e.trace as { args?: { path?: string } })?.args?.path ?? "");
    assert.deepEqual(sseTracePaths, [
      "file-0.ts",
      "file-1.ts",
      "file-2.ts",
      "file-3.ts",
      "file-4.ts",
      "file-5.ts",
    ]);

    // Tool messages handed back to LLM in exact emission order
    assert.equal(seenToolMessagesInRound2.length, 6);
    for (let i = 0; i < 6; i++) {
      assert.ok(
        seenToolMessagesInRound2[i].content.includes(`content of file-${i}.ts`),
        `tool message ${i} must correspond to file-${i}.ts`
      );
    }
  });

  it("Acceptance 1(d): a write call between reads acts as a barrier (strict execution + trace ordering)", async () => {
    const timeline: Array<{ label: string; start: number; end: number }> = [];

    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        const label = `${req.name}:${String(req.arguments.path || "")}`;
        const start = performance.now();
        await sleep(req.name === "workspace_write_file" ? 40 : 60);
        const end = performance.now();
        timeline.push({ label, start, end });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, label }) }] };
      },
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
      ["workspace_write_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    let llmRound = 0;
    const { deps, turnState, fakeJob } = makeTurnDeps({
      tmpDir,
      toolClientMap,
      streamLlmChat: async function* () {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "c0",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "pre-1.ts" }),
                  },
                },
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "pre-2.ts" }),
                  },
                },
                {
                  id: "c2",
                  type: "function",
                  function: {
                    name: "workspace_write_file",
                    arguments: JSON.stringify({ path: "mid.ts", content: "export const x = 1;" }),
                  },
                },
                {
                  id: "c3",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "post-1.ts" }),
                  },
                },
                {
                  id: "c4",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "post-2.ts" }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          yield { message: { content: "Barrier respected." }, finish_reason: "stop" };
        }
      },
    });

    await runChatTurn(deps, fakeJob, null);

    // Trace order strictly matches emission order
    assert.deepEqual(
      turnState.traces.map((t) => `${t.tool}:${String(t.args.path)}`),
      [
        "workspace_read_file:pre-1.ts",
        "workspace_read_file:pre-2.ts",
        "workspace_write_file:mid.ts",
        "workspace_read_file:post-1.ts",
        "workspace_read_file:post-2.ts",
      ]
    );

    const byLabel = new Map(timeline.map((e) => [e.label, e]));
    const pre1 = byLabel.get("workspace_read_file:pre-1.ts")!;
    const pre2 = byLabel.get("workspace_read_file:pre-2.ts")!;
    const mid = byLabel.get("workspace_write_file:mid.ts")!;
    const post1 = byLabel.get("workspace_read_file:post-1.ts")!;
    const post2 = byLabel.get("workspace_read_file:post-2.ts")!;

    // Pre reads completed BEFORE write started
    assert.ok(pre1.end <= mid.start + 1, "pre-1 must complete before barrier write starts");
    assert.ok(pre2.end <= mid.start + 1, "pre-2 must complete before barrier write starts");

    // Write completed BEFORE post reads started
    assert.ok(mid.end <= post1.start + 1, "barrier write must complete before post-1 starts");
    assert.ok(mid.end <= post2.start + 1, "barrier write must complete before post-2 starts");
  });

  it("Acceptance 1(e): one failing read inside a fan-out batch does not drop its siblings", async () => {
    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        const p = String(req.arguments.path || "");
        await sleep(30);
        if (p === "bad.ts") {
          throw new Error("Simulated EACCES read failure");
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ content: `1 | ok ${p}` }) }],
        };
      },
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    let llmRound = 0;
    const toolReplies: string[] = [];
    const { deps, turnState, fakeJob } = makeTurnDeps({
      tmpDir,
      toolClientMap,
      streamLlmChat: async function* (_url, payload) {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "f0",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "ok-1.ts" }),
                  },
                },
                {
                  id: "f1",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "bad.ts" }),
                  },
                },
                {
                  id: "f2",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "ok-2.ts" }),
                  },
                },
                {
                  id: "f3",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "ok-3.ts" }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          for (const m of payload.messages as Array<{ role?: string; content?: string }>) {
            if (m.role === "tool") toolReplies.push(String(m.content || ""));
          }
          yield { message: { content: "Recovered with sibling results." }, finish_reason: "stop" };
        }
      },
    });

    await runChatTurn(deps, fakeJob, null);

    assert.equal(turnState.traces.length, 4, "all 4 calls must have traces");
    assert.deepEqual(
      turnState.traces.map((t) => t.args.path),
      ["ok-1.ts", "bad.ts", "ok-2.ts", "ok-3.ts"]
    );
    assert.equal(toolReplies.length, 4, "all 4 tool results must reach the model");
    assert.ok(toolReplies[0].includes("ok ok-1.ts"));
    assert.ok(toolReplies[1].includes("Simulated EACCES read failure"));
    assert.ok(toolReplies[2].includes("ok ok-2.ts"));
    assert.ok(toolReplies[3].includes("ok ok-3.ts"));
  });

  it("composes Part 1 multi-read + Part 2 parallel fan-out + per-file dedup across rounds", async () => {
    const secret = "compose-test-host-runner-secret-32-chars";
    const hostServer = createHostServer({ port: 0, sharedSecret: secret });
    await hostServer.start();
    const addr = hostServer.server.address() as { port: number };
    const origHostUrl = process.env.HOST_RUNNER_URL;
    const origSecret = process.env.HOST_RUNNER_SHARED_SECRET;
    process.env.HOST_RUNNER_URL = `http://127.0.0.1:${addr.port}`;
    process.env.HOST_RUNNER_SHARED_SECRET = secret;

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compose-fanout-"));
    const dirA = path.join(fixtureRoot, "dir-a");
    const dirB = path.join(fixtureRoot, "dir-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const fileA1 = path.join(dirA, "a1.ts");
    const fileA2 = path.join(dirA, "a2.ts");
    const fileB1 = path.join(dirB, "b1.ts");
    fs.writeFileSync(
      fileA1,
      Array.from({ length: 15 }, (_, i) => `export const a1_${i} = ${i};`).join("\n")
    );
    fs.writeFileSync(
      fileA2,
      Array.from({ length: 15 }, (_, i) => `export const a2_${i} = ${i};`).join("\n")
    );
    fs.writeFileSync(
      fileB1,
      Array.from({ length: 15 }, (_, i) => `export const b1_${i} = ${i};`).join("\n")
    );

    try {
      const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
        ["host_read_file", { client: null, tier: "host" }],
      ]);

      let llmRound = 0;
      const round3ToolPayloads: string[] = [];

      const { deps, turnState, fakeJob } = makeTurnDeps({
        tmpDir,
        toolClientMap,
        hostAccess: true,
        streamLlmChat: async function* (_url, payload) {
          llmRound++;
          if (llmRound === 1) {
            // Round 1: emit TWO multi-reads in the same round -> fans out
            yield {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "mr_1",
                    type: "function",
                    function: {
                      name: "host_read_file",
                      arguments: JSON.stringify({ paths: [dirA] }),
                    },
                  },
                  {
                    id: "mr_2",
                    type: "function",
                    function: {
                      name: "host_read_file",
                      arguments: JSON.stringify({ paths: [dirB] }),
                    },
                  },
                ],
              },
              finish_reason: "stop",
            };
          } else if (llmRound === 2) {
            // Mutate fileA2 on disk, keep fileA1 unchanged, then re-read dirA
            fs.writeFileSync(
              fileA2,
              Array.from({ length: 15 }, (_, i) => `export const a2_modified_${i} = ${i};`).join(
                "\n"
              )
            );
            yield {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "mr_3",
                    type: "function",
                    function: {
                      name: "host_read_file",
                      arguments: JSON.stringify({ paths: [dirA] }),
                    },
                  },
                ],
              },
              finish_reason: "stop",
            };
          } else {
            for (const m of payload.messages as Array<{ role?: string; content?: string }>) {
              if (m.role === "tool") round3ToolPayloads.push(String(m.content || ""));
            }
            yield {
              message: { content: "Composed multi-read + fan-out complete." },
              finish_reason: "stop",
            };
          }
        },
      });

      await runChatTurn(deps, fakeJob, null);

      assert.equal(turnState.traces.length, 3);
      assert.equal(turnState.turnReadDedups.length, 1, "only unchanged a1.ts should be deduped");
      assert.equal(turnState.turnReadDedups[0].path, fileA1);

      // The 3rd tool payload sent to LLM has a1.ts stubbed and a2.ts full new content
      const thirdParsed = JSON.parse(round3ToolPayloads[2]) as {
        files: Array<{ path: string; content: string; deduplicated?: boolean }>;
      };
      const a1Out = thirdParsed.files.find((f) => f.path === fileA1)!;
      const a2Out = thirdParsed.files.find((f) => f.path === fileA2)!;
      assert.equal(a1Out.deduplicated, true);
      assert.match(a1Out.content, /^\[Read dedup:/);
      assert.ok(!a2Out.deduplicated);
      assert.ok(a2Out.content.includes("a2_modified_0"));
    } finally {
      await hostServer.stop();
      if (origHostUrl === undefined) delete process.env.HOST_RUNNER_URL;
      else process.env.HOST_RUNNER_URL = origHostUrl;
      if (origSecret === undefined) delete process.env.HOST_RUNNER_SHARED_SECRET;
      else process.env.HOST_RUNNER_SHARED_SECRET = origSecret;
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("R4: multi-tool round pushes tool_call_id on every tool message, flushes mid-batch directives after all tool messages, and does not duplicate assistant(tool_calls) before synthesis", async () => {
    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
        if (req.name === "search_web") {
          return {
            content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com", title: "Ex" }] }) }],
          };
        }
        if (req.name === "workspace_write_file") {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: true, path: req.arguments.path }) }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ content: `1 | ${String(req.arguments.path)}` }) }],
        };
      },
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["search_web", { client: fakeClient, tier: "browser" }],
      ["workspace_write_file", { client: fakeClient, tier: "sandbox" }],
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    let llmRound = 0;
    let synthesisMessages: Array<{
      role?: string;
      name?: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id?: string }>;
      content?: string;
    }> = [];

    const { deps, fakeJob } = makeTurnDeps({
      tmpDir,
      toolClientMap,
      streamLlmChat: async function* (_url, payload) {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "tc_search",
                  type: "function",
                  function: {
                    name: "search_web",
                    arguments: JSON.stringify({ query: "example architecture" }),
                  },
                },
                {
                  id: "tc_write_svg",
                  type: "function",
                  function: {
                    name: "workspace_write_file",
                    arguments: JSON.stringify({ path: "diagram.svg", content: "<svg></svg>" }),
                  },
                },
                {
                  id: "tc_read_after",
                  type: "function",
                  function: {
                    name: "workspace_read_file",
                    arguments: JSON.stringify({ path: "notes.md" }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          synthesisMessages = (payload.messages as typeof synthesisMessages).map((m) => ({ ...m }));
          yield { message: { content: "Saved diagram.svg and summarized." }, finish_reason: "stop" };
        }
      },
    });
    deps.userPrompt = "Create an SVG architecture diagram";
    deps.messages = [{ role: "user", content: "Create an SVG architecture diagram" }];

    await runChatTurn(deps, fakeJob, null);

    assert.equal(llmRound, 2, "must run round 1 tool batch + post-tool synthesis pass");

    // 1. Every role: "tool" message carries its matching tool_call_id
    const toolMsgs = synthesisMessages.filter((m) => m.role === "tool");
    assert.deepEqual(
      toolMsgs.map((m) => m.tool_call_id),
      ["tc_search", "tc_write_svg", "tc_read_after"]
    );

    // 2. Strictly assistant(tool_calls) -> tool(c0) -> tool(c1) -> tool(c2) -> user(directive)
    const firstAssistantIdx = synthesisMessages.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length === 3
    );
    assert.ok(firstAssistantIdx >= 0, "assistant(tool_calls) message must exist");
    assert.equal(synthesisMessages[firstAssistantIdx + 1]?.role, "tool");
    assert.equal(synthesisMessages[firstAssistantIdx + 1]?.tool_call_id, "tc_search");
    assert.equal(synthesisMessages[firstAssistantIdx + 2]?.role, "tool");
    assert.equal(synthesisMessages[firstAssistantIdx + 2]?.tool_call_id, "tc_write_svg");
    assert.equal(synthesisMessages[firstAssistantIdx + 3]?.role, "tool");
    assert.equal(synthesisMessages[firstAssistantIdx + 3]?.tool_call_id, "tc_read_after");
    assert.equal(synthesisMessages[firstAssistantIdx + 4]?.role, "user");
    assert.match(String(synthesisMessages[firstAssistantIdx + 4]?.content || ""), /\[DELIVERABLE SAVED\]/);

    // 3. No duplicate unpaired assistant(tool_calls) before synthesis
    const assistantToolCallMsgs = synthesisMessages.filter(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    );
    assert.equal(
      assistantToolCallMsgs.length,
      1,
      "post-tool synthesis must NOT receive a duplicate unpaired assistant(tool_calls) message"
    );
  });

  it("R4: searchBlocked halting a multi-tool batch emits synthetic skipped tool stubs with tool_call_id and flushes directives after all tool messages", async () => {
    const fakeClient = {
      callTool: async (req: { name: string; arguments: Record<string, unknown> }) => ({
        content: [{ type: "text", text: JSON.stringify({ content: `1 | ${String(req.arguments.path)}` }) }],
      }),
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["search_web", { client: fakeClient, tier: "browser" }],
      ["workspace_read_file", { client: fakeClient, tier: "sandbox" }],
    ]);

    let llmRound = 0;
    let synthesisMessages: Array<{
      role?: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id?: string }>;
      content?: string;
    }> = [];

    const { deps, fakeJob } = makeTurnDeps({
      tmpDir,
      toolClientMap,
      streamLlmChat: async function* (_url, payload) {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "s0",
                  type: "function",
                  function: { name: "search_web", arguments: JSON.stringify({ query: "" }) },
                },
                {
                  id: "s1",
                  type: "function",
                  function: { name: "search_web", arguments: JSON.stringify({ query: "" }) },
                },
                {
                  id: "r2",
                  type: "function",
                  function: { name: "workspace_read_file", arguments: JSON.stringify({ path: "after.ts" }) },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          synthesisMessages = (payload.messages as typeof synthesisMessages).map((m) => ({ ...m }));
          yield { message: { content: "Handled blocked search." }, finish_reason: "stop" };
        }
      },
    });

    await runChatTurn(deps, fakeJob, null);

    const assistantIdx = synthesisMessages.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length === 3
    );
    assert.ok(assistantIdx >= 0);
    assert.equal(synthesisMessages[assistantIdx + 1]?.role, "tool");
    assert.equal(synthesisMessages[assistantIdx + 1]?.tool_call_id, "s0");
    assert.equal(synthesisMessages[assistantIdx + 2]?.role, "tool");
    assert.equal(synthesisMessages[assistantIdx + 2]?.tool_call_id, "s1");
    assert.equal(synthesisMessages[assistantIdx + 3]?.role, "tool");
    assert.equal(synthesisMessages[assistantIdx + 3]?.tool_call_id, "r2");
    assert.match(String(synthesisMessages[assistantIdx + 3]?.content || ""), /SKIPPED/i);
    assert.equal(synthesisMessages[assistantIdx + 4]?.role, "user");
    assert.match(
      String(synthesisMessages[assistantIdx + 4]?.content || ""),
      /\[QUERY REVISION REQUIRED\]/
    );
  });

  it("R4: barrier MCP callTool throwing an error is caught and returned as a structured error tool result without aborting the turn", async () => {
    const fakeClient = {
      callTool: async () => {
        throw new Error("MCP transport timeout");
      },
      close: async () => {},
    } as unknown as Client;

    const toolClientMap: RunChatTurnDeps["toolClientMap"] = new Map([
      ["workspace_run_command", { client: fakeClient, tier: "sandbox" }],
    ]);

    let llmRound = 0;
    const round2ToolMsgs: Array<{ role?: string; tool_call_id?: string; content?: string }> = [];

    const { deps, turnState, events, fakeJob } = makeTurnDeps({
      tmpDir,
      toolClientMap,
      streamLlmChat: async function* (_url, payload) {
        llmRound++;
        if (llmRound === 1) {
          yield {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "barrier_err_0",
                  type: "function",
                  function: {
                    name: "workspace_run_command",
                    arguments: JSON.stringify({ command: "npm test" }),
                  },
                },
              ],
            },
            finish_reason: "stop",
          };
        } else {
          for (const m of payload.messages as typeof round2ToolMsgs) {
            if (m.role === "tool") round2ToolMsgs.push(m);
          }
          yield { message: { content: "Recovered cleanly from barrier MCP error." }, finish_reason: "stop" };
        }
      },
    });

    await runChatTurn(deps, fakeJob, null);

    assert.equal(llmRound, 2, "turn must continue to round 2 instead of aborting");
    assert.equal(round2ToolMsgs.length, 1);
    assert.equal(round2ToolMsgs[0].tool_call_id, "barrier_err_0");
    assert.match(String(round2ToolMsgs[0].content || ""), /MCP transport timeout/);
    assert.equal(turnState.traces.length, 1);
    assert.ok(events.some((e) => e.type === "done"));
  });
});
