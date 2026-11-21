import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThreadStore } from "../lib/threads/threadStore";
import { GET as getBoard } from "../app/api/board/route";
import { evaluatePrePrGate } from "../lib/prePrPipeline";

describe("P5.1 & P5.2: /api/board (UI-051) & Pre-PR FlowMonitor/ReviewerGate", () => {
  let tmpThreadsDir: string;
  let originalThreadsDir: string | undefined;

  beforeEach(() => {
    tmpThreadsDir = path.join(
      os.tmpdir(),
      `p5-board-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    );
    fs.mkdirSync(tmpThreadsDir, { recursive: true });
    originalThreadsDir = process.env.THREADS_DIR;
    process.env.THREADS_DIR = tmpThreadsDir;
  });

  afterEach(() => {
    if (originalThreadsDir === undefined) delete process.env.THREADS_DIR;
    else process.env.THREADS_DIR = originalThreadsDir;
    fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
  });

  it("P5.1 (UI-051): /api/board returns thread-backed items when threads exist", async () => {
    const store = new ThreadStore(tmpThreadsDir);
    const t = await store.createThread({ title: "Active build thread", taskId: "task-p5-1" });

    const resp = await getBoard();
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.items), "board items must be an array");
    const found = data.items.find((item: { id: string; title?: string }) => item.id === t.id);
    assert.ok(found, "board must include the thread created in ThreadStore");
    assert.equal(found.title, "Active build thread");
  });

  it("P5.2: evaluatePrePrGate blocks PR readiness unless FlowMonitor, ReviewerGate, and test gate all pass", () => {
    const blocked = evaluatePrePrGate({
      flowChecksPassed: false,
      reviewerApproved: true,
      gatePassed: true,
    });
    assert.equal(blocked.ready, false);
    assert.ok(blocked.reasons.length > 0);

    const ready = evaluatePrePrGate({
      flowChecksPassed: true,
      reviewerApproved: true,
      gatePassed: true,
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.reasons.length, 0);
  });
});
