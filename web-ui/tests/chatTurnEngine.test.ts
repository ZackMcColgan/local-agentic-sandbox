import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSseEventWriter,
  createRoundDeadline,
  buildAbortedAssistantMessage,
  runSynthesisPass,
} from "../lib/chat/turnEngine";

describe("chat turn engine", () => {
  it("createSseEventWriter encodes SSE data frames and closes cleanly", async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const ac = new AbortController();
    const sse = createSseEventWriter({
      stream,
      signal: ac.signal,
      activeThreadId: "thread-1",
      heartbeatIntervalMs: 60_000,
      log: () => {},
    });

    const reader = stream.readable.getReader();
    const readAll = (async () => {
      const decoder = new TextDecoder();
      let out = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      return out;
    })();

    await sse.sendEvent({ type: "status", status: "ready" });
    sse.stopHeartbeat();
    await sse.closeWriterWithTimeout(500);
    ac.signal.removeEventListener("abort", sse.cleanupClientSignal);

    const payload = await readAll;
    assert.equal(payload, 'data: {"type":"status","status":"ready"}\n\n');
    assert.equal(sse.isClientDisconnected(), false);
  });

  it("createSseEventWriter marks client disconnected on signal abort", async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const ac = new AbortController();
    const sse = createSseEventWriter({
      stream,
      signal: ac.signal,
      activeThreadId: "thread-2",
      heartbeatIntervalMs: 60_000,
      log: () => {},
    });

    ac.abort();
    assert.equal(sse.isClientDisconnected(), true);
    await sse.sendEvent({ type: "token", content: "ignored" });
    await sse.closeWriterWithTimeout(200);
  });

  it("createRoundDeadline aborts on inactivity timeout and clears cleanly", async () => {
    const ac = new AbortController();
    const deadline = createRoundDeadline(ac, { inactivityMs: 25, totalMs: 500 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ac.signal.aborted, true);
    assert.equal(deadline.getTimedOut(), "inactivity");
    deadline.clear();
  });

  it("buildAbortedAssistantMessage stamps stopped vs disconnected markers", () => {
    const stopped = buildAbortedAssistantMessage({
      assistantMessageId: "a1",
      activeThreadId: "t1",
      threadsDir: "/nonexistent",
      turnCreatedFiles: [],
      turnPreImages: new Map(),
      turnHostDiffs: [],
      explicitStopped: true,
      turnSignalAborted: true,
      accumulatedStreamedTokens: "Partial answer",
      accumulatedThoughts: ["step 1"],
      traces: [],
      activeModel: "test-model",
      turnMicroElisions: [],
      turnReadDedups: [],
      nowIso: "2026-11-21T00:00:00.000Z",
    });
    assert.equal(stopped.status, "incomplete");
    assert.equal(stopped.isStopped, true);
    assert.ok(stopped.content.includes("Partial answer"));
    assert.ok(stopped.content.includes("*[Stopped by user]*"));
    assert.equal(stopped.finish_reason, "abort");
  });

  it("Fix 6: buildAbortedAssistantMessage carries roundPromptTokens, roundGenerationMs, and tokenEconomics rollup", () => {
    const aborted = buildAbortedAssistantMessage({
      assistantMessageId: "a-abort-tokens",
      activeThreadId: "t1",
      threadsDir: "/nonexistent",
      turnCreatedFiles: [],
      turnPreImages: new Map(),
      turnHostDiffs: [],
      explicitStopped: true,
      turnSignalAborted: true,
      accumulatedStreamedTokens: "Partial answer",
      accumulatedThoughts: [],
      traces: [],
      activeModel: "test-model",
      turnOutputTokens: 320,
      roundPromptTokens: [4200, 6100],
      roundGenerationMs: [850, 1200],
      dispatchedRounds: 2,
      compactions: 1,
      turnMicroElisions: [],
      turnReadDedups: [],
      nowIso: "2026-11-27T00:00:00.000Z",
    });

    assert.equal(aborted.outputTokens, 320);
    assert.deepEqual(aborted.roundPromptTokens, [4200, 6100]);
    assert.deepEqual(aborted.roundGenerationMs, [850, 1200]);
    assert.deepEqual(aborted.tokenEconomics, {
      rounds: 2,
      promptTokens: 10300,
      outputTokens: 320,
      compactions: 1,
    });
  });

  it("runSynthesisPass streams thinking + content and forwards token/usage callbacks", async () => {
    const events: Record<string, unknown>[] = [];
    const promptTokens: number[] = [];
    let outputTokens = 0;
    let finishReason = "";
    let streamed = "";
    const turnAc = new AbortController();

    const result = await runSynthesisPass({
      llmBaseUrl: "http://127.0.0.1:11434",
      activeModel: "test-model",
      conversationMessages: [{ role: "user", content: "summarize" }],
      isArtifactRequest: false,
      turnAbortSignal: turnAc.signal,
      synthOptions: {},
      accumulatedThoughts: [],
      getAccumulatedStreamedTokens: () => streamed,
      setAccumulatedStreamedTokens: (next) => {
        streamed = next;
      },
      onFinishReason: (r) => {
        finishReason = r;
      },
      onPromptTokens: (t) => promptTokens.push(t),
      onOutputTokens: (t) => {
        outputTokens = t;
      },
      maybeWriteSnapshot: () => {},
      sendEvent: async (ev) => {
        events.push(ev);
      },
      streamChat: async function* () {
        yield { message: { thinking: "plan" } };
        yield {
          message: { content: "Final summary." },
          finish_reason: "stop",
          promptTokens: 120,
          outputTokens: 15,
        };
      },
      deadlines: { inactivityMs: 5000, totalMs: 10000 },
      log: () => {},
    });

    assert.equal(result.thinking, "plan");
    assert.equal(result.content, "Final summary.");
    assert.equal(finishReason, "stop");
    assert.deepEqual(promptTokens, [120]);
    assert.equal(outputTokens, 15);
    assert.equal(streamed, "Final summary.");
    assert.ok(events.some((e) => e.type === "thinking"));
    assert.ok(events.some((e) => e.type === "token" && e.content === "Final summary."));
  });
});
