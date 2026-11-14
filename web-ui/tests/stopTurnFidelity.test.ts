import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";
import { POST } from "../app/api/threads/[id]/route";
import {
  ThreadStore,
  registerTurnAbortController,
  getActiveTurn,
} from "../lib/threads/threadStore";

describe("UI-028c: POST /api/threads/[id] { action: 'stop' } aborts turn and preserves stopped marker", () => {
  it("aborts the active chat turn and marks the tail assistant message with *[Stopped by user]*", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-turn-fidelity-"));
    process.env.THREADS_DIR = tmpDir;
    const store = new ThreadStore(tmpDir);
    const thread = store.createThread("Stop fidelity test");
    store.addMessage(thread.id, {
      id: "u1",
      role: "user",
      content: "Write a long story",
      timestamp: new Date().toISOString(),
    });
    store.addMessage(thread.id, {
      id: "a1",
      role: "assistant",
      content: "Once upon a time",
      status: "streaming",
      timestamp: new Date().toISOString(),
    });

    const controller = new AbortController();
    registerTurnAbortController(thread.id, controller);

    try {
      const req = new NextRequest(`http://localhost:3000/api/threads/${thread.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: thread.id }) });
      assert.equal(res.status, 200);
      assert.equal(controller.signal.aborted, true, "server turn AbortController should be aborted");
      assert.equal(getActiveTurn(thread.id), null, "turn should no longer be active");

      const updated = await store.getThread(thread.id);
      assert.ok(updated);
      const lastMsg = updated!.messages[updated!.messages.length - 1];
      assert.equal(lastMsg.role, "assistant");
      assert.ok(lastMsg.content.includes("Once upon a time"), "partial content should be preserved");
      assert.ok(lastMsg.content.includes("*[Stopped by user]*"), "stopped marker should be appended");
      assert.equal(lastMsg.isStopped, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
