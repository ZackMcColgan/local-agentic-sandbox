import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import http from "node:http";
import { getHostSettings, setHostSettings, getHostSettingsFilePath } from "../lib/hostSettings";

describe("Phase 2: Chat Route Job Chunking Global Gate", () => {
  let settingsFile: string;
  let originalContent: string | null = null;

  beforeEach(() => {
    settingsFile = getHostSettingsFilePath();
    if (fs.existsSync(settingsFile)) {
      originalContent = fs.readFileSync(settingsFile, "utf8");
      fs.unlinkSync(settingsFile);
    } else {
      originalContent = null;
    }
  });

  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(settingsFile, originalContent, "utf8");
    } else {
      // force: tolerates a parallel test file deleting the shared
      // settings path between the check and the unlink (ENOENT race).
      fs.rmSync(settingsFile, { force: true });
    }
  });

  function makeScriptedEngineServer() {
    let chatCallCount = 0;
    const server = http.createServer((req, res) => {
      const url = req.url || "";
      if (url.includes("/health")) {
        res.writeHead(404);
        res.end("no runner");
        return;
      }
      if (url.includes("/sse") || url.includes("/mcp") || url.includes("/browser")) {
        res.writeHead(404);
        res.end("no mcp");
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (url.includes("/api/chat")) {
          chatCallCount += 1;
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          if (chatCallCount <= 25) {
            // Rounds 0..24: emit a tool call so the turn exceeds the default 25-round budget
            res.write(
              JSON.stringify({
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "workspace_read_file",
                        arguments: { path: "package.json" },
                      },
                    },
                  ],
                },
              }) + "\n"
            );
            res.write(
              JSON.stringify({
                message: { role: "assistant", content: "" },
                done: true,
                eval_count: 10,
              }) + "\n"
            );
          } else {
            // Round 1+: complete normally
            res.write(
              JSON.stringify({
                message: { role: "assistant", content: "Completed without chunking." },
              }) + "\n"
            );
            res.write(
              JSON.stringify({
                message: { role: "assistant", content: "" },
                done: true,
                eval_count: 10,
              }) + "\n"
            );
          }
          res.end();
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });
    return server;
  }

  async function runChunkBudgetTurn(jobChunkingEnabled: boolean) {
    const tmpThreadsDir = path.resolve(
      process.cwd(),
      "tmp-chunk-gate-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)
    );
    fs.mkdirSync(tmpThreadsDir, { recursive: true });
    const prev = {
      THREADS_DIR: process.env.THREADS_DIR,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
      MCP_SERVER_URL: process.env.MCP_SERVER_URL,
      BROWSER_MCP_URL: process.env.BROWSER_MCP_URL,
      LLM_ENGINE: process.env.LLM_ENGINE,
    };
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";
    setHostSettings({ jobChunkingEnabled });

    const server = makeScriptedEngineServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
    process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;

    const threadId = `thread-chunk-gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const handoffPath = path.resolve(
      process.cwd(),
      "..",
      "docs",
      "internal",
      "handoffs",
      `${threadId}.md`
    );

    try {
      const { ThreadStore } = await import("../lib/threads/threadStore");
      const store = new ThreadStore(tmpThreadsDir);
      store.createThread({
        id: threadId,
        title: "Chunk Gate Test Thread",
        isTest: true,
      } as unknown as Parameters<typeof store.createThread>[0]);

      const { NextRequest } = await import("next/server");
      const chatRouteModule = await import("../app/api/chat/route");
      const req = new NextRequest("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "u-1",
          assistantMessageId: "a-1",
          messages: [{ role: "user", content: "Run a multi-round task.", id: "u-1" }],
          model: "swift-15-27b-mtp",
        }),
      });
      const res = await chatRouteModule.POST(
        req as unknown as Parameters<typeof chatRouteModule.POST>[0]
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sseOutput = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseOutput += decoder.decode(value, { stream: true });
      }
      const handoffExists = fs.existsSync(handoffPath);
      if (handoffExists) {
        fs.unlinkSync(handoffPath);
      }
      return { sseOutput, handoffExists };
    } finally {
      server.close();
      Object.entries(prev).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
      fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
    }
  }

  it("(a) switch OFF + turn exceeding budget completes with NO chunk marker and NO handoff file", async () => {
    const { sseOutput, handoffExists } = await runChunkBudgetTurn(false);
    assert.equal(
      handoffExists,
      false,
      "Handoff file must NOT be written when jobChunkingEnabled is false"
    );
    assert.ok(
      !sseOutput.includes("[[CHUNK_COMPLETE]]"),
      "SSE output must NOT contain [[CHUNK_COMPLETE]] marker when jobChunkingEnabled is false"
    );
    assert.ok(
      sseOutput.includes("Completed without chunking."),
      "Turn must complete normally when jobChunkingEnabled is false"
    );
  });

  it("(b) switch ON + same turn chunks as today", async () => {
    const { sseOutput } = await runChunkBudgetTurn(true);
    assert.ok(
      sseOutput.includes("[[CHUNK_COMPLETE]]"),
      "SSE output MUST contain [[CHUNK_COMPLETE]] marker when jobChunkingEnabled is true"
    );
  });

  it("(c) setting persists across simulated restart (store re-read)", () => {
    setHostSettings({ jobChunkingEnabled: false });
    assert.equal(getHostSettings().jobChunkingEnabled, false);
    setHostSettings({ jobChunkingEnabled: true });
    assert.equal(getHostSettings().jobChunkingEnabled, true);
  });

  it("(d) supervisor executeTaskWithRecovery honors jobChunkingEnabled=false (no chunk stop) and =true (chunk stops)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { OvernightSupervisor } = await import("../lib/subagents/supervisor");
    const tmpBase = path.resolve(
      process.cwd(),
      "tmp-sup-chunk-gate-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)
    );
    const tmpRepo = path.join(tmpBase, "repo");
    const tmpCheckpoints = path.join(tmpBase, "checkpoints");
    fs.mkdirSync(tmpRepo, { recursive: true });
    fs.mkdirSync(tmpCheckpoints, { recursive: true });

    try {
      execFileSync("git", ["init"], { cwd: tmpRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: tmpRepo,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpRepo, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpRepo, "init.txt"), "init\n", "utf8");
      execFileSync("git", ["add", "init.txt"], { cwd: tmpRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo, stdio: "ignore" });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tmpRepo,
        encoding: "utf8",
      }).trim();

      const makeTask = (taskId: string) => ({
        taskId,
        goal: "Supervisor chunking toggle test",
        toolchain: "node:22" as const,
        branchName: `feat/${taskId}`,
        status: "active" as const,
        milestones: [
          {
            id: "M1",
            title: "Milestone 1",
            description: "First",
            acceptanceCriteria: [{ id: "AC1", assertion: "ok" }],
            status: "pending" as const,
            builderIterations: 0,
            criticRounds: 0,
          },
          {
            id: "M2",
            title: "Milestone 2",
            description: "Second",
            acceptanceCriteria: [{ id: "AC2", assertion: "ok" }],
            status: "pending" as const,
            builderIterations: 0,
            criticRounds: 0,
          },
        ],
        currentMilestoneIndex: 0,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const supervisor = new OvernightSupervisor({ checkpointDirectory: tmpCheckpoints });

      // 1. Toggle OFF: must complete both milestones without chunk-stopping
      setHostSettings({ jobChunkingEnabled: false });
      const resOff = await supervisor.executeTaskWithRecovery(makeTask("task-chunk-off"), {
        repoRoot: tmpRepo,
        chunkBudget: { maxRounds: 1 },
        stepExecutor: async () => ({ status: "completed", gitSha: headSha }),
      });
      assert.equal(
        resOff.status,
        "completed",
        "Supervisor job must complete when jobChunkingEnabled is false"
      );
      assert.equal(resOff.milestones[0].status, "completed");
      assert.equal(resOff.milestones[1].status, "completed");
      assert.notEqual(resOff.parkedReason, "[[CHUNK_COMPLETE]]");

      // 2. Toggle ON: must pause at chunk boundary after 1 round
      setHostSettings({ jobChunkingEnabled: true });
      const resOn = await supervisor.executeTaskWithRecovery(makeTask("task-chunk-on"), {
        repoRoot: tmpRepo,
        chunkBudget: { maxRounds: 1 },
        stepExecutor: async () => ({ status: "completed", gitSha: headSha }),
      });
      assert.equal(
        resOn.status,
        "paused",
        "Supervisor job must pause at chunk boundary when jobChunkingEnabled is true"
      );
      assert.equal(resOn.parkedReason, "[[CHUNK_COMPLETE]]");
      assert.equal(resOn.milestones[0].status, "completed");
      assert.equal(resOn.milestones[1].status, "pending");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
