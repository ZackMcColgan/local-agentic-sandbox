import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/engine/route";

describe("Engine Control Route (/api/engine)", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LLM_SUPERVISOR_URL = "http://127.0.0.1:11434";
    process.env.LLM_SUPERVISOR_TOKEN = "test-token-xyz";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  describe("GET /api/engine", () => {
    it("proxies /control/status to supervisor passing X-Control-Token", async () => {
      let interceptedUrl = "";
      let interceptedHeaders: any = {};

      globalThis.fetch = (async (input: any, init?: any) => {
        interceptedUrl = String(input);
        interceptedHeaders = init?.headers || {};
        return new Response(
          JSON.stringify({
            status: "running",
            pid: 12345,
            uptime_s: 360,
            model: "swift-15-27b-mtp",
            vram_mb: 16384
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as any;

      const res = await GET();
      assert.equal(res.status, 200);
      const json = await res.json();

      assert.equal(interceptedUrl, "http://127.0.0.1:11434/control/status");
      assert.equal(interceptedHeaders["X-Control-Token"], "test-token-xyz");
      assert.equal(json.status, "running");
      assert.equal(json.reachable, true);
      assert.equal(json.pid, 12345);
      assert.equal(json.model, "swift-15-27b-mtp");
    });

    it("returns status 'stopped' and reachable false when supervisor is offline", async () => {
      globalThis.fetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as any;

      const res = await GET();
      assert.equal(res.status, 200);
      const json = await res.json();

      assert.equal(json.status, "stopped");
      assert.equal(json.reachable, false);
      assert.ok(json.error.includes("Supervisor offline"));
      assert.equal(json.model, "swift-15-27b-mtp");
    });
  });

  describe("POST /api/engine", () => {
    it("rejects missing or invalid action with 400", async () => {
      const req = new NextRequest("http://localhost:3000/api/engine", {
        method: "POST",
        body: JSON.stringify({ action: "destroy_everything" }),
        headers: { "Content-Type": "application/json" }
      });

      const res = await POST(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.ok(json.error.includes("Invalid action"));
    });

    it("dispatches POST /control/stop with token and returns stopped status", async () => {
      let interceptedUrl = "";
      let interceptedHeaders: any = {};

      globalThis.fetch = (async (input: any, init?: any) => {
        interceptedUrl = String(input);
        interceptedHeaders = init?.headers || {};
        return new Response(
          JSON.stringify({ status: "stopped" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as any;

      const req = new NextRequest("http://localhost:3000/api/engine", {
        method: "POST",
        body: JSON.stringify({ action: "stop" }),
        headers: { "Content-Type": "application/json" }
      });

      const res = await POST(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      assert.equal(interceptedUrl, "http://127.0.0.1:11434/control/stop");
      assert.equal(interceptedHeaders["X-Control-Token"], "test-token-xyz");
      assert.equal(json.success, true);
      assert.equal(json.action, "stop");
      assert.equal(json.status, "stopped");
    });

    it("dispatches POST /control/start with token and returns starting status", async () => {
      let interceptedUrl = "";
      let interceptedHeaders: any = {};

      globalThis.fetch = (async (input: any, init?: any) => {
        interceptedUrl = String(input);
        interceptedHeaders = init?.headers || {};
        return new Response(
          JSON.stringify({ status: "starting" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as any;

      const req = new NextRequest("http://localhost:3000/api/engine", {
        method: "POST",
        body: JSON.stringify({ action: "start" }),
        headers: { "Content-Type": "application/json" }
      });

      const res = await POST(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      assert.equal(interceptedUrl, "http://127.0.0.1:11434/control/start");
      assert.equal(interceptedHeaders["X-Control-Token"], "test-token-xyz");
      assert.equal(json.success, true);
      assert.equal(json.action, "start");
      assert.equal(json.status, "starting");
    });

    it("handles restart by issuing stop then start in sequence", async () => {
      const calls: string[] = [];

      globalThis.fetch = (async (input: any) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({ status: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as any;

      const req = new NextRequest("http://localhost:3000/api/engine", {
        method: "POST",
        body: JSON.stringify({ action: "restart" }),
        headers: { "Content-Type": "application/json" }
      });

      const res = await POST(req);
      assert.equal(res.status, 200);
      const json = await res.json();

      assert.equal(calls.length, 2);
      assert.equal(calls[0], "http://127.0.0.1:11434/control/stop");
      assert.equal(calls[1], "http://127.0.0.1:11434/control/start");
      assert.equal(json.success, true);
      assert.equal(json.action, "restart");
    });
  });
});
