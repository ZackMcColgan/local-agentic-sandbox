import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { ThreadStore, ThreadMessage, resolveThreadsDir } from "../lib/threads/threadStore.js";
import {
  buildFileDeliverablesDirective,
  getThreadOutputsWorkspaceRelPath,
  resolveTurnOutputPath,
  recordTurnOutputWrite,
  collectTurnAttachments,
  ThreadTurnWriteTracker
} from "../lib/threadOutputs.js";
import { GET } from "../app/api/files/route.js";
import { NextRequest } from "next/server";

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

test("F5.3: buildFileDeliverablesDirective generates correct workspace relative target path", () => {
  const directive = buildFileDeliverablesDirective("thread-abc");
  assert.ok(
    directive.includes(".agent/threads/thread-abc/files/<filename>"),
    `Expected prompt text to contain .agent/threads/thread-abc/files/<filename>, got: ${directive}`
  );
  assert.ok(directive.includes("workspace_write_file"));
});

test("F5.4: Exact write tracking with collectTurnAttachments and no mtime leaks", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-write-tracking-"));
  const prevThreadsDir = process.env.THREADS_DIR;
  process.env.THREADS_DIR = tmpDir;

  try {
    const threadId = "thread-turn-test";
    const threadOutputsDir = path.join(tmpDir, threadId, "files");
    fs.mkdirSync(threadOutputsDir, { recursive: true });

    // Pre-populate older.html (with fresh mtime right now) and current.html
    const olderFile = path.join(threadOutputsDir, "older.html");
    const currentFile = path.join(threadOutputsDir, "current.html");
    fs.writeFileSync(olderFile, "<html><body>Older</body></html>", "utf8");
    fs.writeFileSync(currentFile, "<html><body>Current</body></html>", "utf8");

    // Record writes ONLY for .agent/threads/<threadId>/files/current.html and unrelated repo write
    const tracker = new ThreadTurnWriteTracker(threadId, tmpDir);
    const recordedList: string[] = [];

    const recCurrent = recordTurnOutputWrite(recordedList, `.agent/threads/${threadId}/files/current.html`, threadId, tmpDir);
    const recUnrelated = recordTurnOutputWrite(recordedList, "web-ui/app/page.tsx", threadId, tmpDir);

    tracker.recordWrite(`.agent/threads/${threadId}/files/current.html`);
    tracker.recordWrite("web-ui/app/page.tsx");

    assert.equal(recCurrent, "current.html");
    assert.equal(recUnrelated, null, "Writes outside thread directory must return null");

    // Collect turn attachments: must ONLY include current.html, NOT older.html, NOT page.tsx
    const attachments = collectTurnAttachments(threadId, tmpDir, recordedList);
    assert.equal(attachments.length, 1, `Expected exactly 1 attachment, got: ${JSON.stringify(attachments)}`);
    assert.equal(attachments[0].name, "current.html");
    assert.equal(attachments[0].previewUrl, `${threadId}/files/current.html`);
    assert.equal(attachments[0].type, "text/html");

    // Class tracker collect() must match
    const classAttachments = tracker.collect();
    assert.equal(classAttachments.length, 1);
    assert.equal(classAttachments[0].name, "current.html");

    // Subsequent turn with zero workspace_write_file calls returns [] even with fresh mtime
    const emptyTurnAttachments = collectTurnAttachments(threadId, tmpDir, []);
    assert.deepEqual(emptyTurnAttachments, [], "Turn with zero recorded writes must return empty attachments");

    // Nested subpath support inside files/
    const subDir = path.join(threadOutputsDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });
    const chartSvg = path.join(subDir, "chart.svg");
    fs.writeFileSync(chartSvg, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>', "utf8");

    const nestedList: string[] = [];
    const recNested = recordTurnOutputWrite(nestedList, `.agent/threads/${threadId}/files/sub/chart.svg`, threadId, tmpDir);
    assert.equal(recNested, "sub/chart.svg");

    const nestedAttachments = collectTurnAttachments(threadId, tmpDir, nestedList);
    assert.equal(nestedAttachments.length, 1);
    assert.equal(nestedAttachments[0].name, "chart.svg");
    assert.equal(nestedAttachments[0].previewUrl, `${threadId}/files/sub/chart.svg`);
    assert.equal(nestedAttachments[0].type, "image/svg+xml");

    // Verify GET /api/files?path=<threadId>/files/sub/chart.svg&download=1 works
    const req = new NextRequest(`http://localhost:3000/api/files?path=${threadId}/files/sub/chart.svg&download=1`);
    const res = await GET(req);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    const disposition = res.headers.get("content-disposition");
    assert.ok(disposition && disposition.includes('filename="chart.svg"'));
  } finally {
    if (prevThreadsDir !== undefined) {
      process.env.THREADS_DIR = prevThreadsDir;
    } else {
      delete process.env.THREADS_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
