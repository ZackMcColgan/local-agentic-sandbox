import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { ThreadStore } from "../lib/threads/threadStore";

describe("Durable Clear Messages — ThreadStore, API route, and ChatStream wiring", () => {
  it("1. ThreadStore.clearThreadMessages empties persisted messages while preserving id, title, and status", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-clear-"));
    try {
      const store = new ThreadStore(tmpDir);
      const created = store.createThread({
        title: "Keep My Title",
        model: "test-model",
        initialPrompt: "First user message",
      });
      created.status = "completed";
      created.messages.push({
        id: "m-2",
        role: "assistant",
        content: "Assistant reply",
        timestamp: new Date().toISOString(),
      });
      store.saveThread(created);

      const before = await store.getThread(created.id);
      assert.ok(
        before && before.messages.length >= 2,
        "Thread must have persisted messages before clear"
      );

      const cleared = await store.clearThreadMessages(created.id);
      assert.ok(cleared, "clearThreadMessages must return the updated thread");
      assert.strictEqual(cleared!.messages.length, 0, "Returned thread must have 0 messages");
      assert.strictEqual(cleared!.title, "Keep My Title", "Title must survive clear");
      assert.strictEqual(cleared!.status, "completed", "Status must survive clear");

      // Simulate reload with a fresh ThreadStore instance reading from disk
      const reloadedStore = new ThreadStore(tmpDir);
      const reloaded = await reloadedStore.getThread(created.id);
      assert.ok(reloaded, "Thread must still exist on disk after clear");
      assert.strictEqual(
        reloaded!.messages.length,
        0,
        "Reloaded thread must still have 0 messages"
      );
      assert.strictEqual(reloaded!.title, "Keep My Title", "Reloaded title must survive");
      assert.strictEqual(reloaded!.status, "completed", "Reloaded status must survive");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("2. ThreadStore.clearThreadMessages returns null for unknown threadId", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-clear-missing-"));
    try {
      const store = new ThreadStore(tmpDir);
      const res = await store.clearThreadMessages("non-existent-thread");
      assert.strictEqual(res, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3. /api/threads route handles clearMessages action and ChatStream invokes it", () => {
    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "../app/api/threads/route.ts"),
      "utf-8"
    );
    assert.ok(
      routeSrc.includes('body.action === "clearMessages"'),
      "route.ts must handle clearMessages action"
    );
    assert.ok(
      routeSrc.includes("clearThreadMessages"),
      "route.ts must call threadStore.clearThreadMessages"
    );

    const chatSrc = fs.readFileSync(
      path.resolve(__dirname, "../components/ChatStream.tsx"),
      "utf-8"
    );
    assert.ok(
      chatSrc.includes('action: "clearMessages"'),
      "ChatStream Clear messages button must persist via /api/threads clearMessages action"
    );
  });
});
