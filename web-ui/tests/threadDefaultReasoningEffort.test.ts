import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { POST } from "../app/api/threads/route";
import { ThreadStore } from "../lib/threads/threadStore";
import { DEFAULT_PRIMARY_MODEL, resolveDefaultReasoningEffort } from "../config/models";

// Fix 8: when the user has NOT chosen a reasoning effort, the resident profile's
// defaultReasoningEffort must govern end to end (thread creation + first turn),
// not a hardcoded "low". An explicit choice (including "low") must still win.
const RESIDENT_MODEL = "qwen3.8-flash-next-gyro-gyro-s";

let tmpDir: string;
let prevThreadsDir: string | undefined;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "las-effort-"));
  prevThreadsDir = process.env.THREADS_DIR;
  process.env.THREADS_DIR = tmpDir;
});

after(() => {
  if (prevThreadsDir === undefined) delete process.env.THREADS_DIR;
  else process.env.THREADS_DIR = prevThreadsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Fix 8 — resident profile default reasoning effort governs thread creation", () => {
  it("resolveDefaultReasoningEffort returns the resident profile default (medium)", () => {
    assert.equal(resolveDefaultReasoningEffort(RESIDENT_MODEL), "medium");
    assert.equal(resolveDefaultReasoningEffort(DEFAULT_PRIMARY_MODEL), "medium");
    // Profiles without a declared default fall back to low.
    assert.equal(resolveDefaultReasoningEffort("gemma4:e4b"), "low");
    assert.equal(resolveDefaultReasoningEffort(undefined), "low");
  });

  it("POST /api/threads with NO explicit effort creates a thread at the profile default (medium)", async () => {
    const req = new Request("http://localhost:3000/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "no effort chosen",
        model: RESIDENT_MODEL,
        initialPrompt: "hello",
      }),
    });
    const res = await POST(req);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.thread.reasoningEffort, "medium", "resident default must be medium, not low");
  });

  it("POST /api/threads with an EXPLICIT low still wins", async () => {
    const req = new Request("http://localhost:3000/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "explicit low",
        model: RESIDENT_MODEL,
        reasoningEffort: "low",
        initialPrompt: "hello",
      }),
    });
    const res = await POST(req);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.thread.reasoningEffort, "low", "explicit low must win over profile default");
  });

  it("ThreadStore.createThread derives the profile default when no effort is passed", () => {
    const store = new ThreadStore(tmpDir);
    const t = store.createThread({ model: RESIDENT_MODEL, initialPrompt: "hi" });
    assert.equal(t.reasoningEffort, "medium");
    const tLow = store.createThread({
      model: RESIDENT_MODEL,
      reasoningEffort: "low",
      initialPrompt: "hi",
    });
    assert.equal(tLow.reasoningEffort, "low");
  });

  it("launchTask path no longer forces low when no effort is chosen", async () => {
    // Stub the heavy planner/executor so the route returns without spawning workers.
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor");
    const originalExecute = OvernightSupervisor.prototype.executeTaskWithRecovery;
    OvernightSupervisor.prototype.executeTaskWithRecovery = async function (task) {
      return task;
    };
    try {
      const req = new Request("http://localhost:3000/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "launchTask",
          goal: "do a thing",
          model: RESIDENT_MODEL,
        }),
      });
      const res = await POST(req);
      assert.ok(res.status === 201 || res.status === 200, `got ${res.status}`);
      const data = await res.json();
      assert.equal(
        data.thread.reasoningEffort,
        "medium",
        "launchTask must not force low when the user chose nothing"
      );
    } finally {
      OvernightSupervisor.prototype.executeTaskWithRecovery = originalExecute;
    }
  });
});
