import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJobMode } from "../../eval/run.mjs";

describe("eval/run.mjs — job mode", () => {
  it("submits to /api/threads with launchTask, goal, and chunkBudget, then polls to completed", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let pollCount = 0;

    const mockFetch = async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/api/threads") && method === "POST") {
        return new Response(JSON.stringify({ thread: { id: "thread-123", status: "active" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/threads/thread-123") && method === "GET") {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              id: "thread-123",
              status: "running",
              messages: [{ role: "assistant", content: "Working..." }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            id: "thread-123",
            status: "completed",
            messages: [
              { role: "user", content: "Solve task" },
              { role: "assistant", content: "Intermediate" },
              { role: "assistant", content: "Final answer ```js\nexport const ok = true;\n```" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const trace = await runJobMode({
      sandboxUrl: "http://127.0.0.1:3000",
      prompt: "Solve task",
      chunkRounds: 8,
      pollIntervalMs: 1,
      timeoutMs: 5000,
      fetchImpl: mockFetch as typeof fetch,
    });

    assert.equal(calls[0].url, "http://127.0.0.1:3000/api/threads");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, {
      action: "launchTask",
      goal: "Solve task",
      chunkBudget: { maxRounds: 8 },
    });

    assert.equal(pollCount, 2);
    assert.equal(trace.output, "Final answer ```js\nexport const ok = true;\n```");
  });

  it("throws and writes last known thread state to trace file on poll timeout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-job-timeout-"));
    const tracePath = path.join(tmpDir, "task-1.trace.json");

    const mockFetch = async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (url.endsWith("/api/threads") && method === "POST") {
        return new Response(
          JSON.stringify({ thread: { id: "thread-timeout", status: "active" } }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/api/threads/thread-timeout") && method === "GET") {
        return new Response(
          JSON.stringify({
            id: "thread-timeout",
            status: "running",
            messages: [{ role: "assistant", content: "Still running" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      await assert.rejects(
        () =>
          runJobMode({
            sandboxUrl: "http://127.0.0.1:3000",
            prompt: "Timeout task",
            chunkRounds: 8,
            pollIntervalMs: 5,
            timeoutMs: 15,
            tracePath,
            taskId: "task-1",
            fetchImpl: mockFetch as typeof fetch,
          }),
        /timed out/i
      );

      assert.ok(fs.existsSync(tracePath), "Trace file must be written on timeout");
      const written = JSON.parse(fs.readFileSync(tracePath, "utf8"));
      assert.equal(written.raw?.status, "running");
      assert.equal(written.raw?.id, "thread-timeout");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
