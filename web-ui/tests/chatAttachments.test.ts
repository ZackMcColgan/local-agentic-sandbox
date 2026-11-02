import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { ThreadStore, ThreadMessage, resolveThreadsDir } from "../lib/threads/threadStore.js";

test("ThreadStore retains message attachments across reloads", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-att-test-"));
  const prevThreadsDir = process.env.THREADS_DIR;
  process.env.THREADS_DIR = tmpDir;

  try {
    const store = new ThreadStore();
    const thread = store.createThread({
      title: "Test Thread with Attachments",
      model: "swift-15-27b-mtp"
    });

    const assistantMsg: ThreadMessage = {
      id: "msg-assistant-1",
      role: "assistant",
      content: "Here is your generated game file.",
      timestamp: new Date().toISOString(),
      attachments: [
        {
          name: "breakout.html",
          type: "text/html",
          size: 2048,
          previewUrl: `${thread.id}/files/breakout.html`
        }
      ]
    };

    thread.messages.push(assistantMsg);
    await store.saveThread(thread);

    // Reload from disk via fresh store instance
    const freshStore = new ThreadStore();
    const loaded = await freshStore.getThread(thread.id);

    assert.ok(loaded);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].id, "msg-assistant-1");
    assert.ok(loaded.messages[0].attachments);
    assert.equal(loaded.messages[0].attachments.length, 1);
    assert.equal(loaded.messages[0].attachments[0].name, "breakout.html");
    assert.equal(loaded.messages[0].attachments[0].type, "text/html");
    assert.equal(loaded.messages[0].attachments[0].size, 2048);
    assert.equal(loaded.messages[0].attachments[0].previewUrl, `${thread.id}/files/breakout.html`);
  } finally {
    if (prevThreadsDir !== undefined) {
      process.env.THREADS_DIR = prevThreadsDir;
    } else {
      delete process.env.THREADS_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Thread file outputs folder resolution and discovery", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-output-test-"));
  const prevThreadsDir = process.env.THREADS_DIR;
  process.env.THREADS_DIR = tmpDir;

  try {
    const threadId = "thread-xyz-123";
    const threadOutputsDir = path.join(resolveThreadsDir(), threadId, "files");
    fs.mkdirSync(threadOutputsDir, { recursive: true });

    const sampleFile = path.join(threadOutputsDir, "snake.html");
    fs.writeFileSync(sampleFile, "<html><body>Snake</body></html>", "utf8");

    assert.ok(fs.existsSync(sampleFile));
    const stat = fs.statSync(sampleFile);
    assert.ok(stat.size > 0);

    const relPath = `${threadId}/files/snake.html`;
    assert.equal(relPath, "thread-xyz-123/files/snake.html");
  } finally {
    if (prevThreadsDir !== undefined) {
      process.env.THREADS_DIR = prevThreadsDir;
    } else {
      delete process.env.THREADS_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
