import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore } from "../lib/threads/threadStore.js";

describe("P0.3 — Data-loss fixes", () => {
  it("listThreadSummaries excludes .steer.json sidecar files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p03-steer-"));
    try {
      const store = new ThreadStore(tmpDir);
      const t = await store.createThread({ title: "Real thread" });
      fs.writeFileSync(
        path.join(tmpDir, `${t.id}.steer.json`),
        JSON.stringify({ steer: "hello" }),
        "utf8"
      );

      const summaries = await store.listThreadSummaries();
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].id, t.id);
      assert.ok(summaries.every((s) => typeof s.id === "string" && s.id.length > 0));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("upsertMessage does not overwrite populated server fields with undefined client fields", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p03-upsert-"));
    try {
      const store = new ThreadStore(tmpDir);
      const t = await store.createThread({ title: "Upsert guard" });
      await store.upsertMessage(t.id, {
        id: "msg-1",
        role: "assistant",
        content: "server content",
        timestamp: new Date().toISOString(),
        roundPromptTokens: 1234,
        outputTokens: 567,
        phaseTimings: { thinkingMs: 100, generationMs: 200 },
      } as unknown as Parameters<typeof store.upsertMessage>[1]);

      // Client completion upserts with undefined token/timing fields
      await store.upsertMessage(t.id, {
        id: "msg-1",
        role: "assistant",
        content: "server content",
        timestamp: new Date().toISOString(),
        roundPromptTokens: undefined,
        outputTokens: undefined,
        phaseTimings: undefined,
      } as unknown as Parameters<typeof store.upsertMessage>[1]);

      const updated = await store.getThread(t.id);
      const msg = updated?.messages.find((m) => m.id === "msg-1") as unknown as {
        roundPromptTokens?: number;
        outputTokens?: number;
        phaseTimings?: { thinkingMs?: number; generationMs?: number };
      };
      assert.equal(msg.roundPromptTokens, 1234);
      assert.equal(msg.outputTokens, 567);
      assert.deepEqual(msg.phaseTimings, { thinkingMs: 100, generationMs: 200 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
