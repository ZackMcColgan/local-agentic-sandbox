import test from "node:test";
import assert from "node:assert/strict";
import {
  TelemetryTracer,
  getTraceSession,
  getAllTraceSessions,
  getTraceStoreSize,
  MAX_TRACE_SESSIONS,
} from "../lib/telemetry";

test("OpenTelemetry Distributed Tracing Suite", async (t) => {
  await t.test("creates root agent.turn span and child spans with correct hierarchy", () => {
    const tracer = new TelemetryTracer("test_session_123");
    const rootSpan = tracer.startSpan("agent.turn", undefined, {
      mode: "auto",
      model: "gemma4:e4b",
    });

    assert.equal(rootSpan.spanId, tracer.getRootSpanId());

    const triageSpan = tracer.startSpan("router.triage", rootSpan.spanId, {
      model: "gemma4:e4b",
    });
    triageSpan.end("ok", { result: "SIMPLE_EXECUTION" });

    const toolSpan = tracer.startSpan("mcp.tool_call", rootSpan.spanId, {
      tool: "workspace_run_command",
    });

    const bashSpan = tracer.startSpan("sandbox.bash_exec", toolSpan.spanId, {
      command: "pytest",
    });
    bashSpan.end("ok", { exit_code: 0 });
    toolSpan.end("ok");

    rootSpan.end("ok");

    const session = getTraceSession("test_session_123");
    assert.ok(session);
    assert.equal(session.sessionId, "test_session_123");
    assert.equal(session.spans.length, 4);

    const names = session.spans.map((s) => s.name);
    assert.ok(names.includes("agent.turn"));
    assert.ok(names.includes("router.triage"));
    assert.ok(names.includes("mcp.tool_call"));
    assert.ok(names.includes("sandbox.bash_exec"));

    // Check parentage
    const triage = session.spans.find((s) => s.name === "router.triage");
    assert.equal(triage?.parentSpanId, rootSpan.spanId);

    const bash = session.spans.find((s) => s.name === "sandbox.bash_exec");
    assert.equal(bash?.parentSpanId, toolSpan.spanId);
  });

  await t.test("calculates durationMs and status accurately", () => {
    const tracer = new TelemetryTracer("timing_test_session");
    const span = tracer.startSpan("model.reasoning", undefined, { round: 1 });
    const completed = span.end("ok", { tokensGenerated: 120 });

    assert.ok(completed.durationMs !== undefined && completed.durationMs >= 1);
    assert.equal(completed.status, "ok");
    assert.equal(completed.attributes.tokensGenerated, 120);
  });

  await t.test("W3C traceparent formatting and parsing", async () => {
    const { formatTraceparent, parseTraceparent } = await import("../lib/telemetry");
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";

    const tp = formatTraceparent(traceId, spanId);
    assert.equal(tp, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

    const parsed = parseTraceparent(tp);
    assert.ok(parsed);
    assert.equal(parsed.traceId, traceId);
    assert.equal(parsed.spanId, spanId);

    assert.equal(parseTraceparent("invalid"), null);
  });

  await t.test(
    "Phase E: Distributed span propagation across supervisor -> planner -> worker -> critic",
    async () => {
      const { OvernightSupervisor } = await import("../lib/subagents/supervisor");
      const tracer = new TelemetryTracer("test_supervisor_trace");
      const supervisor = new OvernightSupervisor({
        checkpointDirectory: "tmp/test-chk",
        tracer,
      });

      const mockTask = {
        taskId: "task-telemetry-eval",
        goal: "Implement OTel propagation",
        currentMilestoneIndex: 0,
        milestones: [
          { id: "m1", title: "Milestone 1", description: "First milestone", status: "pending" },
        ],
        checkpoints: [],
      } as unknown as Parameters<typeof supervisor.executeMilestoneWithTelemetry>[0];

      const result = await supervisor.executeMilestoneWithTelemetry(mockTask, 0, async () => {
        return {
          diff: "diff --git a/file b/file\n+test",
          gitSha: "abc123sha",
          approved: true,
          feedback: ["Clean pass"],
        };
      });

      assert.ok(result.traceId);
      assert.ok(result.supervisorSpanId);
      assert.ok(result.plannerSpanId);
      assert.ok(result.workerSpanId);
      assert.ok(result.criticSpanId);

      const session = getTraceSession("test_supervisor_trace");
      assert.ok(session);

      // Verify parent-child linkage:
      // supervisor -> planner -> worker -> critic
      const spans = session.spans;
      const supSpan = spans.find((s) => s.spanId === result.supervisorSpanId);
      const planSpan = spans.find((s) => s.spanId === result.plannerSpanId);
      const workSpan = spans.find((s) => s.spanId === result.workerSpanId);
      const critSpan = spans.find((s) => s.spanId === result.criticSpanId);

      assert.ok(supSpan, "Supervisor span must exist");
      assert.ok(planSpan, "Planner span must exist");
      assert.ok(workSpan, "Worker span must exist");
      assert.ok(critSpan, "Critic span must exist");

      // All spans must share the same traceId
      assert.equal(planSpan.traceId, supSpan.traceId);
      assert.equal(workSpan.traceId, supSpan.traceId);
      assert.equal(critSpan.traceId, supSpan.traceId);

      // Verify parent-child linkage:
      // Planner is child of Supervisor
      assert.equal(planSpan.parentSpanId, supSpan.spanId);
      // Worker is child of Planner
      assert.equal(workSpan.parentSpanId, planSpan.spanId);
      // Critic is child of Worker
      assert.equal(critSpan.parentSpanId, workSpan.spanId);
    }
  );

  await t.test(
    "trace store enforces the documented cap of 50 sessions, evicting oldest first",
    () => {
      // Insert well beyond the documented cap with strictly increasing start
      // times so eviction order is deterministic regardless of sessions created
      // by earlier subtests in this file.
      const sessionIds: string[] = [];
      const base = Date.now() + 1_000_000;
      for (let i = 0; i < MAX_TRACE_SESSIONS + 12; i++) {
        const id = `cap_session_${i}`;
        sessionIds.push(id);
        const tracer = new TelemetryTracer(id, undefined, base + i);
        tracer.startSpan("agent.turn");
      }

      assert.equal(getTraceStoreSize(), MAX_TRACE_SESSIONS, "store must never exceed the cap");

      // The oldest inserted sessions must be evicted.
      assert.equal(getTraceSession(sessionIds[0]), undefined, "oldest session must be evicted");
      assert.equal(getTraceSession(sessionIds[11]), undefined, "12th-oldest must be evicted");

      // The newest MAX_TRACE_SESSIONS inserted sessions must survive.
      const survivors = sessionIds.slice(sessionIds.length - MAX_TRACE_SESSIONS);
      for (const id of survivors) {
        assert.ok(getTraceSession(id), `${id} must be retained`);
      }
      const newest = getTraceSession(sessionIds[sessionIds.length - 1]);
      assert.ok(newest, "newest session must be retained");
      assert.equal(newest.sessionId, sessionIds[sessionIds.length - 1]);

      // getAllTraceSessions must reflect the bounded store, newest first.
      const all = getAllTraceSessions();
      assert.equal(all.length, MAX_TRACE_SESSIONS);
      assert.ok(all[0].startTime >= all[all.length - 1].startTime, "sorted newest first");
    }
  );

  await t.test("an evicted session lookup behaves sanely", () => {
    // Explicit start times keep eviction order deterministic.
    const base = Date.now() + 2_000_000;
    const tracer = new TelemetryTracer("evict_me", undefined, base);
    tracer.startSpan("agent.turn").end("ok");
    // Push the store past the cap so the oldest session (this one) is evicted.
    for (let i = 1; i <= MAX_TRACE_SESSIONS + 1; i++) {
      const t2 = new TelemetryTracer(`overflow_${i}`, undefined, base + i);
      t2.startSpan("agent.turn");
    }

    assert.equal(getTraceStoreSize(), MAX_TRACE_SESSIONS);
    const evicted = getTraceSession("evict_me");
    assert.equal(evicted, undefined, "evicted session must not be returned");

    // A tracer whose session was evicted must degrade without throwing.
    const stale = new TelemetryTracer("evict_me", undefined, base);
    assert.equal(stale.getSpanHierarchy().length, 0, "evicted session yields empty hierarchy");
    assert.ok(stale.getTraceparent(), "traceparent still derivable from the tracer");
  });
});
