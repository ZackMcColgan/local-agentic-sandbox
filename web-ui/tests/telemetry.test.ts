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
});
