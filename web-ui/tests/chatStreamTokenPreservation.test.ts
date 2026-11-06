import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ThreadStore } from "../lib/threads/threadStore";
import { POST } from "../app/api/chat/route";
import { mergeStreamedTokens } from "../lib/chatStatus";

describe("CHAT-5: Stream Token Preservation & Thread Identity (behavioral)", () => {
  describe("Token preservation contract: mergeStreamedTokens", () => {
    it("keeps accumulated streamed tokens when the done event carries no content", () => {
      assert.equal(mergeStreamedTokens("Round 1 streamed preamble", undefined), "Round 1 streamed preamble");
      assert.equal(mergeStreamedTokens("Round 1 streamed preamble", ""), "Round 1 streamed preamble");
      assert.equal(mergeStreamedTokens("   \n\t  ", "Final synthesis only") , "Final synthesis only");
    });

    it("keeps the done content unchanged when nothing was streamed", () => {
      assert.equal(mergeStreamedTokens("", "Final synthesis content"), "Final synthesis content");
      assert.equal(mergeStreamedTokens(undefined as any, "Final synthesis content"), "Final synthesis content");
    });

    it("does not duplicate when streamed tokens equal the done content", () => {
      assert.equal(mergeStreamedTokens("Exact same output", "Exact same output"), "Exact same output");
    });

    it("keeps whichever side already contains the other (superset wins)", () => {
      const acc = "Initial analysis completed.";
      const evtFull = "Initial analysis completed. Furthermore, the root cause was verified.";
      assert.equal(mergeStreamedTokens(acc, evtFull), evtFull);
      const accFull = "Round 1 results: CPU 98%.\n\nRound 2 synthesis.";
      assert.equal(mergeStreamedTokens(accFull, "Round 2 synthesis."), accFull);
    });

    it("round text streamed before a tool trace survives merge with synthesis-only done content", () => {
      const roundText = "I'll list the files in /workspace using the tree tool.";
      const synthesis = "/workspace contains project files, logs, and scripts.";
      const merged = mergeStreamedTokens(roundText, synthesis);
      assert.ok(merged.includes(roundText), "pre-trace streamed text must survive the done event");
      assert.ok(merged.includes(synthesis));
      assert.equal(merged, `${roundText}\n\n${synthesis}`);
    });

    it("keeps streamed tokens and appends honest pause/incomplete banners", () => {
      const streamed = "Ran tool file_read. Found 3 errors.";
      const paused = "⚠️ [Turn paused: Tool execution limit reached (30 rounds).]";
      const incomplete = "⚠️ [Turn incomplete: Tool execution concluded without synthesis text. Traces captured above.]";
      assert.equal(mergeStreamedTokens(streamed, paused), `${streamed}\n\n${paused}`);
      assert.equal(mergeStreamedTokens(streamed, incomplete), `${streamed}\n\n${incomplete}`);
    });

    it("deduplicates overlapping token boundaries cleanly", () => {
      const acc = "The agent verified that the database connection pool is healthy";
      const evt = "healthy and all migration queries executed successfully.";
      assert.equal(mergeStreamedTokens(acc, evt), "The agent verified that the database connection pool is healthy and all migration queries executed successfully.");
    });

    it("joins distinct round outputs without losing tokens", () => {
      const r1 = "Round 1: Ran tool bash to check git status. Found 2 modified files.";
      const r2 = "Round 2: Applied patches and verified build passes cleanly.";
      const merged = mergeStreamedTokens(r1, r2);
      assert.ok(merged.includes(r1) && merged.includes(r2));
      assert.equal(merged, `${r1}\n\n${r2}`);
    });
  });

  describe("Thread identity: /api/chat persists turns under the REAL server-side thread id", () => {
    let tmpThreadsDir: string;
    let originalThreadsDir: string | undefined;
    let originalLlmUrl: string | undefined;

    beforeEach(() => {
      tmpThreadsDir = path.join(os.tmpdir(), `chat5-threads-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
      fs.mkdirSync(tmpThreadsDir, { recursive: true });
      originalThreadsDir = process.env.THREADS_DIR;
      originalLlmUrl = process.env.LLM_BASE_URL;
      process.env.THREADS_DIR = tmpThreadsDir;
      process.env.LLM_BASE_URL = "http://127.0.0.1:59999"; // unreachable: deterministic failure path
    });

    afterEach(() => {
      process.env.THREADS_DIR = originalThreadsDir;
      process.env.LLM_BASE_URL = originalLlmUrl;
      try { fs.rmSync(tmpThreadsDir, { recursive: true, force: true }); } catch {}
    });

    async function drain(res: Response) {
      if (!res.body) return;
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    it("persists user + assistant messages under the requested real thread id", async () => {
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `chat5-real-id-${Date.now()}`;
      store.createThread({ id: threadId, title: "CHAT-5 identity probe" });

      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "chat5-user-1",
          assistantMessageId: "chat5-asst-1",
          messages: [{ role: "user", content: "Probe under real thread id", id: "chat5-user-1" }],
          model: "swift-15-27b-mtp"
        })
      });
      const res = await POST(req as any);
      await drain(res);

      const thread = await store.getThread(threadId);
      assert.ok(thread, "thread must exist under the requested id");
      assert.equal(thread.id, threadId);
      assert.ok(thread.messages.some((m) => m.id === "chat5-user-1" && m.role === "user"),
        "user message must be persisted under the real thread id");
      const asst = thread.messages.find((m) => m.id === "chat5-asst-1");
      assert.ok(asst, "assistant message must be persisted under the real thread id even on failure");
      assert.equal(asst.role, "assistant");
      assert.ok(asst.status === "error" || asst.status === "incomplete");
    });

    it("persists NOTHING when threadId is null — the client must send the ensured id", async () => {
      // Documents why ChatStream must send the ensured activeThreadId, not null.
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: null,
          userMessageId: "chat5-orphan-user",
          assistantMessageId: "chat5-orphan-asst",
          messages: [{ role: "user", content: "Orphan turn with null threadId", id: "chat5-orphan-user" }],
          model: "swift-15-27b-mtp"
        })
      });
      const res = await POST(req as any);
      await drain(res);

      const files = fs.readdirSync(tmpThreadsDir);
      assert.equal(files.length, 0, "a turn with null threadId must persist nothing server-side");
    });
  });

  describe("Permission-hygiene intent (behavioral, platform-guarded)", () => {
    it("thread files carry no world-access bits when POSIX modes are honored", () => {
      if (process.platform === "win32") return; // Windows ignores chmod bits; guarded per CI precedent
      const tmpDir = path.join(os.tmpdir(), `chat5-perm-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        const store = new ThreadStore(tmpDir);
        const t = store.createThread({ title: "perm probe" });
        const fileMode = fs.statSync(store.getFilePath(t.id)).mode & 0o777;
        assert.equal(fileMode & 0o007, 0, "thread file must have no world permissions");
        assert.equal(fs.statSync(tmpDir).mode & 0o007, 0, "threads dir must have no world permissions");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
