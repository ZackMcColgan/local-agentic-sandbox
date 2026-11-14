import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore } from "../lib/threads/threadStore";

describe("NEW-ARGON-02: listThreadSummaries avoids re-reading full thread bodies", () => {
  let tmpDir: string;
  let store: ThreadStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-summaries-cache-"));
    store = new ThreadStore(tmpDir);
    await store.createThread({
      title: "Cached summary test",
      model: "test-model",
      messages: [
        { id: "u1", role: "user", content: "Hello world", timestamp: new Date().toISOString() },
        { id: "a1", role: "assistant", content: "Hi there!", timestamp: new Date().toISOString() },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns identical summary shape without reading full thread JSON on subsequent calls", async () => {
    const first = await store.listThreadSummaries();
    assert.equal(first.length, 1);
    assert.equal(first[0].title, "Cached summary test");

    let threadFileReads = 0;
    const origReadFile = fs.promises.readFile;
    (fs.promises as any).readFile = async (p: any, ...args: any[]) => {
      if (String(p).endsWith(".json") && !String(p).includes(".summaries-cache")) {
        threadFileReads++;
      }
      return origReadFile.call(fs.promises, p, ...args);
    };

    try {
      const second = await store.listThreadSummaries();
      assert.deepEqual(second, first);
      assert.equal(
        threadFileReads,
        0,
        `Expected 0 full thread file reads on cached listThreadSummaries(), got ${threadFileReads}`
      );
    } finally {
      (fs.promises as any).readFile = origReadFile;
    }
  });
});
