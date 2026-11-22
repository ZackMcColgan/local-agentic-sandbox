import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileCheckpointSaver } from "../lib/subagents/supervisor";

describe("FileCheckpointSaver", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-saver-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists checkpoint and writes to disk and reloads them in a new instance", async () => {
    const dir = makeTempDir();
    const saver = new FileCheckpointSaver(dir);

    const config = {
      configurable: {
        thread_id: "thread-alpha",
        checkpoint_ns: "",
      },
    };
    const checkpoint = {
      v: 1,
      id: "cp-1",
      ts: "2026-11-21T00:00:00.000Z",
      channel_values: {
        goal: "test goal",
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
      channel_versions: { goal: 1, bytes: 1 },
      versions_seen: {},
      pending_sends: [],
    };
    const metadata = {
      source: "loop" as const,
      step: 1,
      writes: null,
      parents: {},
    };

    const savedConfig = await saver.put(config, checkpoint, metadata);
    await saver.putWrites(savedConfig, [["goal", "updated"]], "task-1");

    const filePath = saver.getFilePath("thread-alpha");
    assert.equal(fs.existsSync(filePath), true);

    const reloaded = new FileCheckpointSaver(dir);
    const loaded = await reloaded.getTuple({
      configurable: { thread_id: "thread-alpha", checkpoint_ns: "" },
    });

    assert.ok(loaded);
    assert.equal(loaded.checkpoint.id, "cp-1");
    assert.equal(loaded.checkpoint.channel_values.goal, "test goal");
    assert.ok(loaded.checkpoint.channel_values.bytes instanceof Uint8Array);
    assert.deepEqual(
      Array.from(loaded.checkpoint.channel_values.bytes as Uint8Array),
      [1, 2, 3, 4]
    );
    assert.ok(Array.isArray(loaded.pendingWrites));
    assert.equal(loaded.pendingWrites.length, 1);
  });

  it("handles missing checkpoint directory by creating it", () => {
    const base = makeTempDir();
    const nested = path.join(base, "nested", "checkpoints");
    const saver = new FileCheckpointSaver(nested);

    assert.equal(fs.existsSync(nested), true);
    assert.equal(saver.checkpointDir, nested);
  });
});
