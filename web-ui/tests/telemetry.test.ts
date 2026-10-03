import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryTracer, getTraceSession, getAllTraceSessions } from "../lib/telemetry";

test("OpenTelemetry Distributed Tracing Suite", async (t) => {
  await t.test("creates root agent.turn span and child spans with correct hierarchy", () => {
    const tracer = new TelemetryTracer("test_session_123");
    const rootSpan = tracer.startSpan("agent.turn", undefined, {
      mode: "auto",
      model: "gemma4:e4b"
    });

    assert.equal(rootSpan.spanId, tracer.getRootSpanId());

    const triageSpan = tracer.startSpan("router.triage", rootSpan.spanId, {
      model: "gemma4:e4b"
    });
    triageSpan.end("ok", { result: "SIMPLE_EXECUTION" });

    const toolSpan = tracer.startSpan("mcp.tool_call", rootSpan.spanId, {
      tool: "workspace_run_command"
    });

    const bashSpan = tracer.startSpan("sandbox.bash_exec", toolSpan.spanId, {
      command: "pytest"
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

  await t.test("Phase E: Distributed span propagation across supervisor -> planner -> worker -> critic", async () => {
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor");
    const tracer = new TelemetryTracer("test_supervisor_trace");
    const supervisor = new OvernightSupervisor({
      checkpointDirectory: "tmp/test-chk",
      tracer
    });

    const mockTask: any = {
      taskId: "task-telemetry-eval",
      goal: "Implement OTel propagation",
      currentMilestoneIndex: 0,
      milestones: [
        { id: "m1", title: "Milestone 1", description: "First milestone", status: "pending" }
      ],
      checkpoints: []
    };

    const result = await supervisor.executeMilestoneWithTelemetry(mockTask, 0, async () => {
      return {
        diff: "diff --git a/file b/file\n+test",
        gitSha: "abc123sha",
        approved: true,
        feedback: ["Clean pass"]
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
  });
});
