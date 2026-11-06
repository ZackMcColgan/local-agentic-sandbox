import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThreadStore } from "../lib/threads/threadStore";
import { POST as STEER_POST } from "../app/api/threads/[id]/steer/route";
import { NextRequest } from "next/server";

describe("CHAT-STEER — mid-turn steering mailbox (behavioral)", () => {
  let tmpDir: string;
  let store: ThreadStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new ThreadStore(tmpDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("ThreadStore steer mailbox methods", () => {
    it("appendSteer appends to disk mailbox and returns pendingCount", () => {
      const count1 = store.appendSteer("thread-1", "First direction");
      assert.equal(count1, 1);
      const count2 = store.appendSteer("thread-1", "Second direction");
      assert.equal(count2, 2);

      const pending = store.getPendingSteers("thread-1");
      assert.deepEqual(pending, ["First direction", "Second direction"]);
    });

    it("consumeSteers consumes exactly-once and removes mailbox", () => {
      store.appendSteer("thread-1", "Direction A");
      store.appendSteer("thread-1", "Direction B");

      const consumed = store.consumeSteers("thread-1");
      assert.deepEqual(consumed, ["Direction A", "Direction B"]);

      const secondConsume = store.consumeSteers("thread-1");
      assert.deepEqual(secondConsume, [], "second consume must be empty (exactly-once)");
      assert.equal(store.getPendingSteers("thread-1").length, 0);
    });

    it("pending steers survive until consumed", () => {
      store.appendSteer("thread-1", "Direction 1");
      const freshStore = new ThreadStore(tmpDir);
      assert.deepEqual(freshStore.getPendingSteers("thread-1"), ["Direction 1"]);
    });

    it("clearSteers empties the mailbox on thread end", () => {
      store.appendSteer("thread-1", "To be cleared");
      store.clearSteers("thread-1");
      assert.deepEqual(store.getPendingSteers("thread-1"), []);
    });
  });

  describe("POST /api/threads/[id]/steer endpoint", () => {
    it("appends steer and returns pendingCount", async () => {
      process.env.THREADS_DIR = tmpDir;
      const req = new NextRequest("http://localhost/api/threads/t-endpoint/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Please focus on tests" })
      });

      const res = await STEER_POST(req, { params: Promise.resolve({ id: "t-endpoint" }) });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.pendingCount, 1);

      assert.deepEqual(store.getPendingSteers("t-endpoint"), ["Please focus on tests"]);
    });

    it("rejects empty text with 400", async () => {
      const req = new NextRequest("http://localhost/api/threads/t-empty/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "   " })
      });

      const res = await STEER_POST(req, { params: Promise.resolve({ id: "t-empty" }) });
      assert.equal(res.status, 400);
    });
  });
});
