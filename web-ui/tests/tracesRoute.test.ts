import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../app/api/traces/route";
import { TelemetryTracer } from "../lib/telemetry";

describe("Traces API Route (/api/traces)", () => {
  it("returns empty state when no trace sessions exist", async () => {
    const req = new NextRequest("http://localhost:3000/api/traces");
    const res = await GET(req);

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.total_sessions, 0);
    assert.equal(json.latest_session, null);
    assert.deepEqual(json.sessions, []);
  });

  it("returns 404 when querying an unknown sessionId", async () => {
    const req = new NextRequest("http://localhost:3000/api/traces?sessionId=missing-session");
    const res = await GET(req);

    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error, "Trace session not found");
    assert.equal(json.sessionId, "missing-session");
  });

  it("returns populated sessions list and specific session by sessionId", async () => {
    const tracer = new TelemetryTracer("sess_traces_route_test");
    const rootSpan = tracer.startSpan("agent.turn", undefined, { prompt: "hello" });
    const toolSpan = tracer.startSpan("mcp.tool_call", rootSpan.spanId, { tool: "read_file" });
    toolSpan.end("ok");
    rootSpan.end("ok");

    const listReq = new NextRequest("http://localhost:3000/api/traces");
    const listRes = await GET(listReq);

    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.success, true);
    assert.ok(listJson.total_sessions >= 1);
    assert.equal(listJson.latest_session.sessionId, "sess_traces_route_test");
    assert.equal(listJson.latest_session.traceId, tracer.getTraceId());
    assert.equal(listJson.latest_session.spans.length, 2);
    assert.ok(
      listJson.sessions.some((s: { sessionId: string }) => s.sessionId === "sess_traces_route_test")
    );

    const byIdReq = new NextRequest(
      "http://localhost:3000/api/traces?sessionId=sess_traces_route_test"
    );
    const byIdRes = await GET(byIdReq);

    assert.equal(byIdRes.status, 200);
    const byIdJson = await byIdRes.json();
    assert.equal(byIdJson.success, true);
    assert.equal(byIdJson.session.sessionId, "sess_traces_route_test");
    assert.equal(byIdJson.session.traceId, tracer.getTraceId());
    assert.equal(byIdJson.session.spans.length, 2);
  });
});
