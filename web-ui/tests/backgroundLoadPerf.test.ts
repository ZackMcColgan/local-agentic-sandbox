import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

describe("Rank 15 (P-F5 + P-F7) background load & per-turn overhead", () => {
  it("getSharedSkillsStore reuses singleton per resolved dbPath and /api/skills does not close shared handle", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-singleton-"));
    const dbPathA = path.join(tmpDir, "a", "runs.db");
    const dbPathB = path.join(tmpDir, "b", "runs.db");
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const origRunLedgerDb = process.env.RUN_LEDGER_DB_PATH;
    const origSkillsDir = process.env.SKILLS_DIR;

    const mod = (await import("../lib/flywheel/skillsStore.js")) as Record<string, unknown>;
    const getSharedSkillsStore = mod.getSharedSkillsStore as
      | ((dbPath?: string) => {
          saveSkills: (skills: unknown[]) => void;
          listSkills: () => Array<{ skillId: string }>;
          close: () => void;
        })
      | undefined;
    const closeSharedSkillsStore = mod.closeSharedSkillsStore as ((dbPath?: string) => void) | undefined;

    assert.equal(typeof getSharedSkillsStore, "function", "getSharedSkillsStore must be exported");
    assert.equal(
      typeof closeSharedSkillsStore,
      "function",
      "closeSharedSkillsStore must be exported"
    );

    try {
      const s1 = getSharedSkillsStore!(dbPathA);
      const s2 = getSharedSkillsStore!(path.join(tmpDir, "a", ".", "runs.db"));
      assert.strictEqual(s1, s2, "same resolved dbPath must return same singleton instance");

      const sB = getSharedSkillsStore!(dbPathB);
      assert.notStrictEqual(s1, sB, "distinct dbPath must return distinct store instance");

      // Delete DB file externally and confirm getSharedSkillsStore recreates cleanly
      closeSharedSkillsStore!(dbPathA);
      if (fs.existsSync(dbPathA)) fs.unlinkSync(dbPathA);
      const sReopened = getSharedSkillsStore!(dbPathA);
      assert.notStrictEqual(sReopened, s1, "closed/deleted store must be recreated");
      assert.deepEqual(sReopened.listSkills(), []);

      // Verify /api/skills GET uses getSharedSkillsStore and keeps handle open across requests
      process.env.RUN_LEDGER_DB_PATH = dbPathA;
      process.env.SKILLS_DIR = skillsDir;
      sReopened.saveSkills([
        {
          skillId: "skill-shared-check",
          name: "Shared Handle Skill",
          description: "Persisted in shared store",
          domain: "testing",
          patternTemplate: "assert.ok(true)",
          sourceTaskId: "task-shared-1",
          confidenceScore: 0.9,
          createdAt: new Date().toISOString(),
          useCount: 1,
        },
      ]);

      const { GET } = await import("../app/api/skills/route.js");
      const res1 = await GET(new NextRequest("http://localhost:3000/api/skills"));
      assert.equal(res1.status, 200);
      const data1 = await res1.json();
      assert.ok(
        Array.isArray(data1.flywheelSkills) &&
          data1.flywheelSkills.some((s: { skillId: string }) => s.skillId === "skill-shared-check")
      );

      // Shared store must still be open and identical after GET /api/skills completes
      const afterRoute = getSharedSkillsStore!();
      assert.strictEqual(afterRoute, sReopened, "/api/skills must not close the shared store");

      const res2 = await GET(new NextRequest("http://localhost:3000/api/skills"));
      assert.equal(res2.status, 200);

      const routeSrc = fs.readFileSync(
        path.resolve(__dirname, "../app/api/skills/route.ts"),
        "utf8"
      );
      assert.ok(
        routeSrc.includes("getSharedSkillsStore"),
        "app/api/skills/route.ts must use getSharedSkillsStore"
      );
      assert.ok(
        !routeSrc.includes("new FlywheelSkillsStore"),
        "app/api/skills/route.ts must not instantiate FlywheelSkillsStore per request"
      );
    } finally {
      closeSharedSkillsStore?.();
      if (origRunLedgerDb !== undefined) process.env.RUN_LEDGER_DB_PATH = origRunLedgerDb;
      else delete process.env.RUN_LEDGER_DB_PATH;
      if (origSkillsDir !== undefined) process.env.SKILLS_DIR = origSkillsDir;
      else delete process.env.SKILLS_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("page.tsx gates background polling on !document.hidden, active view, and >= 45_000ms status cadence", () => {
    const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");

    // Extract the background polling region around fetchStatus -> handleToggleSelfDeploy
    const statusIdx = pageSrc.indexOf("const fetchStatus");
    const toggleIdx = pageSrc.indexOf("const handleToggleSelfDeploy");
    assert.ok(statusIdx >= 0 && toggleIdx > statusIdx, "expected polling block in page.tsx");
    const pollingSection = pageSrc.slice(Math.max(0, statusIdx - 80), toggleIdx);

    assert.doesNotMatch(
      pollingSection,
      /setInterval\([\s\S]*?,\s*15000\s*\)/,
      "page.tsx must not poll background endpoints every 15000ms"
    );

    const intervalMatch = pollingSection.match(
      /(?:BACKGROUND_STATUS_POLL_INTERVAL_MS\s*=|setInterval\([\s\S]*?,)\s*([0-9_]+)/
    );
    assert.ok(intervalMatch, "expected explicit polling interval constant or literal >= 45000ms");
    const parsedMs = Number(intervalMatch[1].replace(/_/g, ""));
    assert.ok(
      parsedMs >= 45000,
      `expected engine/sandbox status poll interval >= 45000ms, got ${parsedMs}`
    );

    assert.ok(
      pollingSection.includes("document.hidden") && pollingSection.includes("visibilitychange"),
      "background polling must check document.hidden and listen to visibilitychange"
    );

    assert.ok(
      pollingSection.includes('activeNavView === "skills"') &&
        pollingSection.includes('activeNavView === "builds"') &&
        pollingSection.includes('activeNavView === "projects"'),
      "view-specific pollers must be gated by their corresponding activeNavView"
    );
  });

  it("determineHostRunnerState(false) short-circuits with 0 fetch calls", async () => {
    const { determineHostRunnerState } = await import("../lib/hostMode.js");
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("fetch should not be called when hostAccess is false");
    }) as typeof fetch;

    try {
      const status = await determineHostRunnerState(false);
      assert.equal(fetchCalls, 0, "determineHostRunnerState(false) must make 0 fetch calls");
      assert.equal(status.hostAccess, false);
      assert.equal(status.runnerState, "DISABLED");
      assert.equal(status.runnerAvailable, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("getHostSettings caches by mtimeMs and invalidates on file change or setHostSettings", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-settings-cache-"));
    const origSettingsDir = process.env.SETTINGS_DIR;
    process.env.SETTINGS_DIR = tmpDir;

    const mod = (await import("../lib/hostSettings.js")) as Record<string, unknown>;
    const getHostSettings = mod.getHostSettings as () => {
      hostAccessEnabled: boolean;
      jobChunkingEnabled: boolean;
    };
    const setHostSettings = mod.setHostSettings as (u: {
      hostAccessEnabled?: boolean;
      jobChunkingEnabled?: boolean;
    }) => unknown;
    const getHostSettingsFilePath = mod.getHostSettingsFilePath as () => string;
    const resetHostSettingsCache = mod.resetHostSettingsCache as (() => void) | undefined;

    assert.equal(
      typeof resetHostSettingsCache,
      "function",
      "resetHostSettingsCache must be exported"
    );

    const filePath = getHostSettingsFilePath();
    fs.writeFileSync(
      filePath,
      JSON.stringify({ hostAccessEnabled: true, jobChunkingEnabled: true }),
      "utf8"
    );

    const origReadFileSync = fs.readFileSync;
    let settingsReadCount = 0;
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
      p: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof p === "string" && path.resolve(p) === path.resolve(filePath)) {
        settingsReadCount++;
      }
      return (origReadFileSync as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync;

    try {
      resetHostSettingsCache!();
      for (let i = 0; i < 5; i++) {
        const s = getHostSettings();
        assert.equal(s.hostAccessEnabled, true);
      }
      assert.equal(
        settingsReadCount,
        1,
        "repeated getHostSettings() calls with unchanged mtimeMs must read file only once"
      );

      // Update file on disk with a bumped mtime and confirm cache re-reads
      fs.writeFileSync(
        filePath,
        JSON.stringify({ hostAccessEnabled: false, jobChunkingEnabled: true }),
        "utf8"
      );
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(filePath, future, future);

      const updated = getHostSettings();
      assert.equal(updated.hostAccessEnabled, false);
      assert.equal(settingsReadCount, 2, "mtimeMs change must trigger exactly one re-read");

      // setHostSettings must invalidate cache
      setHostSettings({ jobChunkingEnabled: false });
      const afterSave = getHostSettings();
      assert.equal(afterSave.jobChunkingEnabled, false);
    } finally {
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
      resetHostSettingsCache?.();
      if (origSettingsDir !== undefined) process.env.SETTINGS_DIR = origSettingsDir;
      else delete process.env.SETTINGS_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ReadDedupRegistry indexes 500 messages in O(M) (< 50ms) and deduplicates accurately", async () => {
    const { ReadDedupRegistry } = await import("../lib/readDedup.js");

    type TestMsg = {
      role: string;
      name?: string;
      content: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };

    const messages: TestMsg[] = [];
    for (let i = 0; i < 250; i++) {
      const callId = `call_${i}`;
      const filePath = `src/module_${i}.ts`;
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: callId,
            function: {
              name: "workspace_read_file",
              arguments: JSON.stringify({ path: filePath }),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        name: "workspace_read_file",
        tool_call_id: callId,
        content: JSON.stringify({ content: `export const value_${i} = ${i};` }),
      });
    }

    // Instrument tool_calls access count on message[0] to prove O(M) single-pass vs O(M^2) scan
    let msg0ToolCallsReads = 0;
    const rawToolCalls0 = messages[0].tool_calls;
    Object.defineProperty(messages[0], "tool_calls", {
      configurable: true,
      enumerable: true,
      get() {
        msg0ToolCallsReads++;
        return rawToolCalls0;
      },
    });

    const start = performance.now();
    const registry = new ReadDedupRegistry(messages);
    const elapsedMs = performance.now() - start;

    assert.ok(elapsedMs < 50, `Expected < 50ms to index 500 messages, got ${elapsedMs.toFixed(2)}ms`);
    assert.ok(
      msg0ToolCallsReads <= 2,
      `Expected O(M) single-pass indexing (<= 2 accesses on message 0 tool_calls), got ${msg0ToolCallsReads}`
    );

    const unchanged = registry.checkAndRecord(
      "workspace_read_file",
      { path: "src/module_42.ts" },
      JSON.stringify({ content: "export const value_42 = 42;" }),
      251,
      0
    );
    assert.equal(unchanged.deduplicated, true);
    assert.ok(unchanged.stub?.includes("src/module_42.ts"));

    const modified = registry.checkAndRecord(
      "workspace_read_file",
      { path: "src/module_42.ts" },
      JSON.stringify({ content: "export const value_42 = 999;" }),
      252,
      1
    );
    assert.equal(modified.deduplicated, false);
  });

  it("connectMcpClient pools by URL, keeps close() safe/no-op, evicts on error, and resets cleanly", async () => {
    const mod = (await import("../lib/chat/mcpClients.js")) as Record<string, unknown>;
    const connectMcpClient = mod.connectMcpClient as (
      url: string,
      name: string,
      deps?: Record<string, unknown>
    ) => Promise<{
      client: {
        callTool?: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
        close: () => Promise<void>;
      };
      tools: Array<{ name: string }>;
    } | null>;
    const resetMcpClientPool = mod.resetMcpClientPool as (() => Promise<void>) | undefined;

    assert.equal(
      typeof resetMcpClientPool,
      "function",
      "resetMcpClientPool must be exported from mcpClients.ts"
    );

    let createdClients = 0;
    let rawCloseCount = 0;
    let transportCloseCount = 0;
    let shouldFailCallTool = false;

    const deps = {
      pooled: true,
      log: () => {},
      warn: () => {},
      createTransport: () => ({
        close: async () => {
          transportCloseCount++;
        },
      }),
      createClient: () => {
        createdClients++;
        return {
          connect: async () => {},
          listTools: async () => ({ tools: [{ name: "workspace_read_file" }] }),
          callTool: async () => {
            if (shouldFailCallTool) {
              throw new Error("transport disconnected");
            }
            return { content: [{ type: "text", text: "ok" }] };
          },
          close: async () => {
            rawCloseCount++;
          },
        };
      },
    };

    try {
      await resetMcpClientPool!();

      const s1 = await connectMcpClient("http://127.0.0.1:9876", "c1", deps);
      const s2 = await connectMcpClient("http://127.0.0.1:9876/sse", "c2", deps);
      assert.ok(s1 && s2);
      assert.equal(createdClients, 1, "normalized matching URLs must reuse pooled client");

      // Pooled handle close() must be a safe no-op
      await s1.client.close();
      assert.equal(rawCloseCount, 0, "pooled handle close() must not close underlying client");

      const s3 = await connectMcpClient("http://127.0.0.1:9876/sse", "c3", deps);
      assert.ok(s3);
      assert.equal(createdClients, 1, "pooled client must stay reusable after handle close()");

      // Trigger transport error -> evicts dead entry -> next connect reconnects
      shouldFailCallTool = true;
      await assert.rejects(
        () => s3.client.callTool!({ name: "workspace_read_file", arguments: {} }),
        /transport disconnected/
      );
      shouldFailCallTool = false;

      const s4 = await connectMcpClient("http://127.0.0.1:9876/sse", "c4", deps);
      assert.ok(s4);
      assert.equal(createdClients, 2, "evicted pool entry must reconnect on next call");

      await resetMcpClientPool!();
      assert.ok(rawCloseCount >= 1 && transportCloseCount >= 1, "resetMcpClientPool closes handles");
    } finally {
      await resetMcpClientPool?.();
    }
  });
});
