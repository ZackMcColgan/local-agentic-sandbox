import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// 1. Residency and Model Constants
import {
  PINNED_KEEP_ALIVE,
  planResidency,
  fetchModelSizes,
  fetchLoadedModels,
  enforceResidency,
  keepAliveFor
} from "../lib/subagents/residency";
import { DEFAULT_PRIMARY_MODEL } from "../config/models";

// 2. BuilderWorker and WorkerPool
import {
  BuilderWorker,
  createBuilderWorker,
  type BuilderResult
} from "../lib/subagents/workerPool";
import type { Milestone } from "../lib/subagents/types";

// 3. LLM Client thinking budget
import {
  createOllamaGenerate,
  getThinkingBudget
} from "../lib/subagents/llmClient";

describe("Sprint A1 — Zero VRAM Eviction & Multi-File Iterative Builder Suite", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe("Task 1: VRAM Residency & Non-Eviction Policy (Override 2)", () => {
    it("PINNED_KEEP_ALIVE prefers -1 for indefinite VRAM residency", () => {
      assert.equal(PINNED_KEEP_ALIVE, -1, "PINNED_KEEP_ALIVE must prefer -1 (indefinite residency)");
    });

    it("fetchModelSizes normalizes model names stripping :latest and indexes by both", async () => {
      const mockFetch: typeof fetch = async (url) => {
        return new Response(
          JSON.stringify({
            models: [
              { name: "swift-15-27b-mtp:latest", size: 18_000_000_000 },
              { name: "gemma4:e4b", size: 4_000_000_000 }
            ]
          }),
          { status: 200 }
        );
      };

      const sizes = await fetchModelSizes("http://mock-ollama", mockFetch);
      assert.equal(sizes["swift-15-27b-mtp:latest"], 18_000_000_000);
      assert.equal(sizes["swift-15-27b-mtp"], 18_000_000_000, "Must be indexed without :latest");
      assert.equal(sizes["gemma4:e4b"], 4_000_000_000);
    });

    it("fetchLoadedModels normalizes model names stripping :latest", async () => {
      const mockFetch: typeof fetch = async (url) => {
        return new Response(
          JSON.stringify({
            models: [
              { name: "swift-15-27b-mtp:latest", size_vram: 18_000_000_000 }
            ]
          }),
          { status: 200 }
        );
      };

      const loaded = await fetchLoadedModels("http://mock-ollama", mockFetch);
      assert.ok(loaded.some((m) => m.name === "swift-15-27b-mtp" || (m as any).baseName === "swift-15-27b-mtp"));
    });

    it("planResidency always pins DEFAULT_PRIMARY_MODEL even if sizes lookup was skipped or unknown", () => {
      const plan = planResidency({
        roster: { builder: DEFAULT_PRIMARY_MODEL },
        modelSizes: {}, // Empty sizes map (lookup skipped or unindexed)
        vramBudgetBytes: 24 * 1024 ** 3
      });

      assert.ok(
        plan.pinned.includes(DEFAULT_PRIMARY_MODEL),
        `DEFAULT_PRIMARY_MODEL (${DEFAULT_PRIMARY_MODEL}) must always be pinned in planResidency`
      );
    });

    it("Behavioral assertion: swift-15-27b-mtp is not evicted across consecutive prompts in /api/ps", async () => {
      let residentModels: { name: string; size_vram: number }[] = [
        { name: "swift-15-27b-mtp", size_vram: 18_000_000_000 }
      ];

      const mockFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/api/ps")) {
          return new Response(JSON.stringify({ models: residentModels }), { status: 200 });
        }
        if (urlStr.endsWith("/api/generate") || urlStr.endsWith("/api/chat")) {
          const body = JSON.parse(String(init?.body || "{}"));
          // If a call specifies keep_alive: 0, it unloads
          if (body.keep_alive === 0) {
            residentModels = residentModels.filter((m) => m.name !== body.model);
          } else if (body.model) {
            // If another model is loaded in single-slot runner, it displaces the previous model
            if (body.model !== "swift-15-27b-mtp" && body.model !== "swift-15-27b-mtp:latest") {
              residentModels = [{ name: body.model, size_vram: 4_000_000_000 }];
            }
          }
          return new Response(JSON.stringify({ response: "ok", message: { content: "ok" } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      };

      // Before run
      const before = await fetchLoadedModels("http://mock-ollama", mockFetch);
      assert.ok(before.some((m) => m.name.includes("swift-15-27b-mtp")));

      // Enforce residency with pinned model
      const plan = planResidency({
        roster: { builder: "swift-15-27b-mtp" },
        modelSizes: { "swift-15-27b-mtp": 18_000_000_000 },
        vramBudgetBytes: 24 * 1024 ** 3
      });
      await enforceResidency(plan, "http://mock-ollama", mockFetch);

      // Verify still resident
      const afterPrompt1 = await fetchLoadedModels("http://mock-ollama", mockFetch);
      assert.ok(afterPrompt1.some((m) => m.name.includes("swift-15-27b-mtp")), "Must be resident after prompt 1");

      // Consecutive prompt
      await enforceResidency(plan, "http://mock-ollama", mockFetch);
      const afterPrompt2 = await fetchLoadedModels("http://mock-ollama", mockFetch);
      assert.ok(afterPrompt2.some((m) => m.name.includes("swift-15-27b-mtp")), "Must remain resident after prompt 2");
    });

    it("chat/route.ts routes auto mode to DEFAULT_PRIMARY_MODEL directly without gemma4:e4b triage swap", () => {
      const chatRoutePath = fs.existsSync(path.resolve(process.cwd(), "web-ui/app/api/chat/route.ts"))
        ? path.resolve(process.cwd(), "web-ui/app/api/chat/route.ts")
        : path.resolve(process.cwd(), "app/api/chat/route.ts");
      const content = fs.readFileSync(chatRoutePath, "utf8");

      // Verify no triageComplexity call swapping model in auto mode
      assert.ok(
        !content.includes('triageComplexityResult = await triageComplexity'),
        "chat/route.ts must not call triageComplexity in auto mode (swaps gemma4:e4b into VRAM)"
      );

      // Verify flash mode opt-in is preserved
      assert.ok(
        /if\s*\(\s*mode === "flash"\s*\)\s*\{\s*activeModel = "gemma4:e4b";/.test(content),
        "chat/route.ts must preserve explicit user opt-in for flash mode -> gemma4:e4b"
      );

      // Verify auto/pro routes to DEFAULT_PRIMARY_MODEL directly
      assert.ok(
        content.includes("activeModel = DEFAULT_PRIMARY_MODEL;"),
        "chat/route.ts must route auto mode directly to DEFAULT_PRIMARY_MODEL"
      );

      // Verify 2-consecutive-failures auto-escalation path is retained
      assert.ok(
        content.includes("consecutiveFailures >= 2"),
        "chat/route.ts must retain 2-consecutive-failures auto-escalation path"
      );

      // Verify keep_alive: -1 on chat payload
      assert.ok(
        content.includes("keep_alive: -1"),
        "chat/route.ts must send keep_alive: -1 in llmPayload"
      );

      // Verify searchOracleCodebase is called directly without embedding swap
      assert.ok(
        content.includes("searchOracleCodebase(userPrompt)"),
        "chat/route.ts must wire searchOracleCodebase directly without dead embedding swap"
      );
    });
  });

  describe("Task 2: Surgical Search/Replace Patch Tool & BuilderWorker Call Path (Override 3)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("BuilderWorker exercises exact call path to surgically patch a file", async () => {
      const filePath = "src/widget.ts";
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(
        fullPath,
        `export function render() {\n  const color = "red";\n  return color;\n}\n`,
        "utf8"
      );

      const builder = createBuilderWorker();
      assert.equal(typeof (builder as any).patchFile, "function", "BuilderWorker must have patchFile method");

      const patchResult = await (builder as any).patchFile(
        filePath,
        [{ search: 'const color = "red";', replace: 'const color = "emerald";' }],
        { repoRoot: tmpDir }
      );

      assert.equal(patchResult.status, "SUCCESS");
      const updated = fs.readFileSync(fullPath, "utf8");
      assert.ok(updated.includes('const color = "emerald";'));
      assert.ok(!updated.includes('const color = "red";'));
    });

    it("rejects patch when search text is not found", async () => {
      const filePath = "src/widget.ts";
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `const x = 1;\n`, "utf8");

      const builder = createBuilderWorker();
      await assert.rejects(
        async () => {
          await (builder as any).patchFile(
            filePath,
            [{ search: 'const nonexistent = 99;', replace: 'const y = 2;' }],
            { repoRoot: tmpDir }
          );
        },
        /Target text not found|Patch search target not found/
      );
    });
  });

  describe("Task 3: Decoupled Thinking Token Budget & BuilderWorker num_predict", () => {
    it("getThinkingBudget returns 1024 for fast, 4096 for balanced, 8192 for deep", () => {
      assert.equal(getThinkingBudget("fast"), 1024);
      assert.equal(getThinkingBudget("low"), 1024);
      assert.equal(getThinkingBudget("balanced"), 4096);
      assert.equal(getThinkingBudget("medium"), 4096);
      assert.equal(getThinkingBudget("deep"), 8192);
      assert.equal(getThinkingBudget("xhigh"), 8192);
    });

    it("createOllamaGenerate adds thinking budget on top of requested num_predict", async () => {
      let sentOptions: any = null;
      const mockFetch: typeof fetch = async (url, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        sentOptions = body.options;
        return new Response(JSON.stringify({ response: "console.log('done');" }), { status: 200 });
      };

      const generate = createOllamaGenerate({ fetchImpl: mockFetch });
      await generate({
        model: "swift-15-27b-mtp",
        prompt: "write code",
        options: { num_predict: 2048 },
        reasoningEffort: "fast"
      } as any);

      assert.ok(sentOptions, "Ollama request options must be sent");
      // 2048 requested + 1024 thinking budget = 3072
      assert.equal(
        sentOptions.num_predict,
        3072,
        `num_predict must add thinking budget on top: expected 3072, got ${sentOptions.num_predict}`
      );
    });

    it("BuilderWorker defaults num_predict to 8192 for code generation", async () => {
      let sentNumPredict: number | undefined;
      const mockGenerate = async (req: any) => {
        sentNumPredict = req.options?.num_predict;
        return {
          text: "export const x = 1;",
          model: req.model,
          loadDurationMs: 0
        };
      };

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-num-predict-"));
      try {
        const builder = new BuilderWorker({ generate: mockGenerate as any });
        const m: Milestone = {
          id: "M1",
          title: "Generate widget",
          description: "Write code",
          status: "in_progress",
          plannedFiles: ["widget.ts"]
        };

        await builder.executeMilestoneWork(m, { repoRoot: tmpDir });
        assert.equal(
          sentNumPredict,
          8192,
          `BuilderWorker must request num_predict: 8192, got ${sentNumPredict}`
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Task 4: Multi-File BuilderWorker Iteration", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-file-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolveTargets returns all non-empty entries in milestone.plannedFiles", () => {
      const builder = createBuilderWorker();
      const m: Milestone = {
        id: "M1",
        title: "Multi-file milestone",
        description: "Create multiple files",
        status: "in_progress",
        plannedFiles: ["lib/a.ts", "lib/b.ts", "lib/c.ts"]
      };

      assert.equal(typeof (builder as any).resolveTargets, "function", "BuilderWorker must expose resolveTargets");
      const targets = (builder as any).resolveTargets(m);
      assert.deepEqual(targets, ["lib/a.ts", "lib/b.ts", "lib/c.ts"]);
    });

    it("executeMilestoneWork iterates all plannedFiles and returns modifiedFiles array", async () => {
      const createdFiles: Record<string, string> = {};
      const mockGenerate = async (req: any) => {
        // Find which target is being generated from prompt
        const match = req.prompt.match(/content for "([^"]+)"/);
        const file = match ? match[1] : "default.ts";
        return {
          text: `// Content for ${file}\nexport const name = "${file}";`,
          model: req.model,
          loadDurationMs: 0
        };
      };

      const builder = new BuilderWorker({ generate: mockGenerate as any });
      const m: Milestone = {
        id: "M1",
        title: "Multi-file feature",
        description: "Generate multi-file modules",
        status: "in_progress",
        plannedFiles: ["lib/core.ts", "lib/utils.ts"]
      };

      const result = await builder.executeMilestoneWork(m, { repoRoot: tmpDir });
      assert.ok(Array.isArray((result as any).modifiedFiles), "Result must include modifiedFiles array");
      assert.deepEqual((result as any).modifiedFiles, ["lib/core.ts", "lib/utils.ts"]);

      assert.ok(fs.existsSync(path.join(tmpDir, "lib/core.ts")));
      assert.ok(fs.existsSync(path.join(tmpDir, "lib/utils.ts")));
    });
  });
});
