import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore } from "../lib/threads/threadStore";
import { GET } from "../app/api/threads/route";

describe("B1: Lightweight thread summaries", () => {
  it("listThreadSummaries returns <1KB per thread even with 500KB of messages/traces", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-summary-test-"));
    try {
      const store = new ThreadStore(tmpDir);
      const hugeText = "x".repeat(500 * 1024);
      const thread = store.createThread("New session", "swift-15-27b-mtp");
      thread.messages = [
        {
          id: "m1",
          role: "user",
          content: "Inspect the authentication middleware for edge cases",
          timestamp: new Date().toISOString(),
        },
        {
          id: "m2",
          role: "assistant",
          content: hugeText,
          thoughts: hugeText,
          traces: [{ id: "t1", type: "tool", name: "read_file", result: hugeText }] as any,
          diffs: [{ filePath: "a.ts", diff: "+foo" }] as any,
          timestamp: new Date().toISOString(),
        },
      ];
      store.saveThread(thread);

      const summaries = await (store as any).listThreadSummaries();
      const summary = summaries.find((s: any) => s.id === thread.id);
      assert.ok(summary, "Expected created thread summary");
      const serializedSize = Buffer.byteLength(JSON.stringify(summary), "utf8");
      assert.ok(serializedSize < 1024, `Expected summary < 1024 bytes, got ${serializedSize}`);
      assert.equal(summary.messageCount, 2);
      assert.equal(summary.hasDiffs, true);
      assert.ok(typeof summary.lastMessagePreview === "string" && summary.lastMessagePreview.length > 0);
      assert.ok(summary.title && summary.title !== "New session", "Expected derived title");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getThread cache-miss does not trigger full listThreads scan", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-miss-test-"));
    try {
      const store = new ThreadStore(tmpDir);
      let listCalled = false;
      (store as any).listThreads = async () => {
        listCalled = true;
        return [];
      };
      const missing = await store.getThread("non-existent-thread-id");
      assert.equal(missing, null);
      assert.equal(listCalled, false, "getThread cache-miss must not call listThreads()");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("GET /api/threads returns summaries by default and full threads with ?full=1", async () => {
    const resSummary = await GET(new Request("http://localhost/api/threads"));
    assert.equal(resSummary.status, 200);
    const dataSummary = await resSummary.json();
    assert.ok(Array.isArray(dataSummary.threads));
    if (dataSummary.threads.length > 0) {
      assert.equal(dataSummary.threads[0].messages, undefined);
      assert.equal(typeof dataSummary.threads[0].messageCount, "number");
    }

    const resFull = await GET(new Request("http://localhost/api/threads?full=1"));
    assert.equal(resFull.status, 200);
    const dataFull = await resFull.json();
    assert.ok(Array.isArray(dataFull.threads));
  });
});
