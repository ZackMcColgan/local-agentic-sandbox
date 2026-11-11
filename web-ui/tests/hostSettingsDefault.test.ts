import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import http from "node:http";
import {
  getHostSettings,
  setHostSettings,
  getHostSettingsFilePath
} from "../lib/hostSettings";
import { shouldAdvertiseHostTools, HOST_TOOLS_DEFINITIONS } from "../lib/hostMode";
import { getBridgeManifest, PROTOCOL_VERSION } from "../../host-bridge/manifest";

describe("Defect #0: Host Mode Global Settings Default Suite", () => {
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
    } else if (fs.existsSync(settingsFile)) {
      fs.unlinkSync(settingsFile);
    }
  });

  it("1. Fresh state (no stored preference) defaults host access to ON (true)", () => {
    assert.equal(fs.existsSync(settingsFile), false, "Settings file must not exist in fresh state");
    const settings = getHostSettings();
    assert.equal(
      settings.hostAccessEnabled,
      true,
      "Fresh state with no stored preference must default hostAccessEnabled to true"
    );
  });

  it("2. Switch OFF persists and disables host access preference", () => {
    setHostSettings({ hostAccessEnabled: false });
    assert.equal(fs.existsSync(settingsFile), true, "Settings file must exist after update");
    const reloaded = getHostSettings();
    assert.equal(reloaded.hostAccessEnabled, false, "hostAccessEnabled must be false when switched off");
  });

  it("3. Preference persists across server restarts via persistent file store", () => {
    setHostSettings({ hostAccessEnabled: false });
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(raw.hostAccessEnabled, false);

    // Simulate pod restart by reading fresh instance from disk
    const reloaded = getHostSettings();
    assert.equal(reloaded.hostAccessEnabled, false);

    // Toggle back on
    setHostSettings({ hostAccessEnabled: true });
    const reloadedOn = getHostSettings();
    assert.equal(reloadedOn.hostAccessEnabled, true);
  });

  it("4. Switch ON + daemon down (UNAVAILABLE) yields shouldAdvertiseHostTools = false", () => {
    // When hostAccessEnabled is true but runner is UNAVAILABLE / down
    const shouldAdvertise = shouldAdvertiseHostTools(true, "UNAVAILABLE");
    assert.equal(shouldAdvertise, false, "Must not advertise host tools when daemon is UNAVAILABLE");

    const shouldAdvertiseMismatch = shouldAdvertiseHostTools(true, "MISMATCH");
    assert.equal(shouldAdvertiseMismatch, false, "Must not advertise host tools when daemon is in MISMATCH state");

    const shouldAdvertiseReady = shouldAdvertiseHostTools(true, "READY");
    assert.equal(shouldAdvertiseReady, true, "Must advertise host tools when switch is ON and daemon is READY");
  });

  /**
   * 5. Behavioral prohibition test (replaces the former tautological local
   * reimplementation): drives the REAL /api/chat route against a scripted
   * engine + scripted READY host-runner health probe, and asserts what tool
   * payload the route actually advertises. A task thread (taskId present)
   * must NEVER be offered host tools, even with hostAccess ON and a READY
   * runner; an ordinary user-chat thread must be offered them (control).
   */
  function makeScriptedEngineServer(capturedPayloads: any[]) {
    const manifest = getBridgeManifest();
    const server = http.createServer((req, res) => {
      const url = req.url || "";
      if (url.includes("/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          protocolVersion: PROTOCOL_VERSION,
          bridgeSourceSha256: manifest.bridgeSourceSha256
        }));
        return;
      }
      if (url.includes("/sse")) {
        // MCP endpoints unreachable: route falls back gracefully.
        res.writeHead(404);
        res.end("no mcp");
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (url.includes("/api/chat")) {
          try {
            capturedPayloads.push(JSON.parse(body));
          } catch {}
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.write(JSON.stringify({ message: { role: "assistant", content: "All done." } }) + "\n");
          res.write(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, eval_count: 12 }) + "\n");
          res.end();
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });
    return server;
  }

  async function runTurn(threadParams: { title: string; hostAccess: boolean; taskId?: string }) {
    const tmpThreadsDir = path.resolve(
      process.cwd(),
      "tmp-host-prohibition-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6)
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
      HOST_RUNNER_URL: process.env.HOST_RUNNER_URL
    };
    process.env.THREADS_DIR = tmpThreadsDir;
    process.env.LLM_ENGINE = "ollama";

    const capturedPayloads: any[] = [];
    const server = makeScriptedEngineServer(capturedPayloads);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
    process.env.BROWSER_MCP_URL = `http://127.0.0.1:${port}/browser`;
    // Scripted runner reports READY (status ok, matching protocol + digest).
    process.env.HOST_RUNNER_URL = `http://127.0.0.1:${port}`;

    try {
      const { ThreadStore } = await import("../lib/threads/threadStore");
      const store = new ThreadStore(tmpThreadsDir);
      const threadId = `thread-host-prohibition-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      store.createThread({
        id: threadId,
        title: threadParams.title,
        hostAccess: threadParams.hostAccess,
        taskId: threadParams.taskId,
        isTest: true
      });

      const { NextRequest } = await import("next/server");
      const chatRouteModule = await import("../app/api/chat/route");
      const req = new NextRequest("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          userMessageId: "u-1",
          assistantMessageId: "a-1",
          messages: [{ role: "user", content: "Inspect the repo patterns and report what you find.", id: "u-1" }],
          model: "swift-15-27b-mtp"
        })
      });
      const res = await chatRouteModule.POST(req as any);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        decoder.decode(value = undefined as any, { stream: true });
      }
      return capturedPayloads;
    } finally {
      server.close();
      Object.entries(prev).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
      fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
    }
  }

  function advertisedToolNames(capturedPayloads: any[]): string[] {
    return capturedPayloads.flatMap((p) =>
      Array.isArray(p.tools) ? p.tools.map((t: any) => t.function?.name || t.name) : []
    );
  }

  it("5. Task threads are PROHIBITED from receiving host tools regardless of switch (behavioral, real route)", async () => {
    const hostToolNames = HOST_TOOLS_DEFINITIONS.map((ht) => ht.function.name);

    // Control: ordinary user-chat thread, hostAccess ON, runner READY -> host tools advertised.
    const controlNames = advertisedToolNames(
      await runTurn({ title: "Control Chat Thread", hostAccess: true })
    );
    assert.ok(
      controlNames.includes("host_run_powershell"),
      "Control thread with hostAccess ON + READY runner must be offered host tools"
    );

    // Task thread: identical switch + READY runner, but taskId present -> prohibition must hold.
    const taskNames = advertisedToolNames(
      await runTurn({ title: "Task Thread", hostAccess: true, taskId: `task-prohibition-${Date.now()}` })
    );
    assert.ok(taskNames.length > 0, "Task thread turn must still advertise non-host tools");
    for (const hostName of hostToolNames) {
      assert.ok(
        !taskNames.includes(hostName),
        `Task thread must NEVER be offered host tool ${hostName}`
      );
    }
    assert.ok(
      !taskNames.some((n) => n.startsWith("host_")),
      "Task thread must never receive any host-tier tool (including unattended git)"
    );
  });
});
