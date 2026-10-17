import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  resolveLLMEngine,
  getLLMProvider,
  OllamaProvider,
  LlamaCppProvider,
  type LLMChatRequest
} from "../lib/llm/provider";

function createMockSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function createMockNdjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" }
  });
}

describe("LLM Provider Abstraction Suite (Ollama & llama.cpp)", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  describe("Task 1: resolveLLMEngine & getLLMProvider factory", () => {
    it("defaults to 'ollama' when LLM_ENGINE is unset, empty, or 'ollama'", () => {
      delete process.env.LLM_ENGINE;
      assert.equal(resolveLLMEngine(), "ollama");

      process.env.LLM_ENGINE = "";
      assert.equal(resolveLLMEngine(), "ollama");

      process.env.LLM_ENGINE = "ollama";
      assert.equal(resolveLLMEngine(), "ollama");

      process.env.LLM_ENGINE = "OLLAMA";
      assert.equal(resolveLLMEngine(), "ollama");
    });

    it("resolves to 'llamacpp' when LLM_ENGINE is 'llamacpp' or passed explicitly", () => {
      process.env.LLM_ENGINE = "llamacpp";
      assert.equal(resolveLLMEngine(), "llamacpp");

      process.env.LLM_ENGINE = "LLAMACPP";
      assert.equal(resolveLLMEngine(), "llamacpp");

      delete process.env.LLM_ENGINE;
      assert.equal(resolveLLMEngine("llamacpp"), "llamacpp");
      assert.equal(resolveLLMEngine("ollama"), "ollama");
    });

    it("getLLMProvider returns an instance of OllamaProvider or LlamaCppProvider accordingly", () => {
      delete process.env.LLM_ENGINE;
      const defaultProvider = getLLMProvider();
      assert.ok(defaultProvider instanceof OllamaProvider);
      assert.equal(defaultProvider.engine, "ollama");

      process.env.LLM_ENGINE = "llamacpp";
      const llamaCppProvider = getLLMProvider();
      assert.ok(llamaCppProvider instanceof LlamaCppProvider);
      assert.equal(llamaCppProvider.engine, "llamacpp");

      const explicitOllama = getLLMProvider("ollama");
      assert.ok(explicitOllama instanceof OllamaProvider);

      const explicitLlamaCpp = getLLMProvider("llamacpp");
      assert.ok(explicitLlamaCpp instanceof LlamaCppProvider);
    });
  });

  describe("Task 2: OllamaProvider.streamChat behavioral test", () => {
    it("calls ${baseUrl}/api/chat with stream: true and yields normalized chunks from NDJSON", async () => {
      let capturedUrl = "";
      let capturedBody: any = null;

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body || "{}"));
        return createMockNdjsonResponse([
          JSON.stringify({ message: { role: "assistant", content: "Hello " }, done: false }) + "\n",
          JSON.stringify({ message: { role: "assistant", thinking: "Planning..." }, done: false }) + "\n",
          JSON.stringify({
            message: {
              role: "assistant",
              content: "world!",
              tool_calls: [{ function: { name: "search_web", arguments: { query: "local" } } }]
            },
            done: true
          }) + "\n"
        ]);
      }) as any;

      const provider = new OllamaProvider();
      const payload: LLMChatRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        keep_alive: -1,
        options: { temperature: 0.2, num_predict: 256 },
        tools: [{ type: "function", function: { name: "search_web" } }]
      };

      const chunks: any[] = [];
      for await (const chunk of provider.streamChat("http://127.0.0.1:11434", payload)) {
        chunks.push(chunk);
      }

      assert.equal(capturedUrl, "http://127.0.0.1:11434/api/chat");
      assert.equal(capturedBody.stream, true);
      assert.equal(capturedBody.model, "test-model");
      assert.equal(capturedBody.keep_alive, -1);
      assert.equal(capturedBody.options?.temperature, 0.2);
      assert.equal(capturedBody.tools?.length, 1);

      assert.equal(chunks.length, 3);
      assert.equal(chunks[0].message?.content, "Hello ");
      assert.equal(chunks[1].message?.thinking, "Planning...");
      assert.equal(chunks[2].message?.content, "world!");
      assert.equal(chunks[2].message?.tool_calls?.[0]?.function?.name, "search_web");
      assert.equal(chunks[2].done, true);
    });
  });

  describe("Task 3: LlamaCppProvider.streamChat behavioral test", () => {
    it("calls ${baseUrl}/v1/chat/completions with SSE, sets n_keep, and normalizes reasoning, content, and tool calls", async () => {
      let capturedUrl = "";
      let capturedBody: any = null;

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body || "{}"));
        return createMockSseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"Let me analyze the request"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"I will generate an SVG deliverable."}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"workspace_write_file","arguments":"{\\"path\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":": \\"test.svg\\", \\"content\\": \\"<svg></svg>\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n'
        ]);
      }) as any;

      const provider = new LlamaCppProvider();
      const systemMessage = "You are an autonomous AI coding assistant. Maintain high security and quality.";
      const payload: LLMChatRequest = {
        model: "qwen-27b",
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: "Draw an architecture diagram" }
        ],
        tools: [{ type: "function", function: { name: "workspace_write_file" } }],
        options: { temperature: 0.1, num_predict: 1024 }
      };

      const chunks: any[] = [];
      for await (const chunk of provider.streamChat("http://127.0.0.1:8080", payload)) {
        chunks.push(chunk);
      }

      assert.equal(capturedUrl, "http://127.0.0.1:8080/v1/chat/completions");
      assert.equal(capturedBody.stream, true);
      assert.equal(capturedBody.temperature, 0.1);
      assert.equal(capturedBody.max_tokens, 1024);
      assert.equal(capturedBody.tools?.length, 1);
      assert.ok(typeof capturedBody.n_keep === "number");
      assert.ok(capturedBody.n_keep >= 15 && capturedBody.n_keep <= 2048);

      // Check normalized reasoning
      const thinkingChunks = chunks.filter((c) => c.message?.thinking);
      assert.ok(thinkingChunks.length > 0);
      assert.equal(thinkingChunks[0].message?.thinking, "Let me analyze the request");

      // Check normalized content
      const contentChunks = chunks.filter((c) => c.message?.content);
      assert.ok(contentChunks.length > 0);
      assert.equal(contentChunks[0].message?.content, "I will generate an SVG deliverable.");

      // Check accumulated & parsed tool calls emitted
      const toolCallChunks = chunks.filter((c) => c.message?.tool_calls);
      assert.ok(toolCallChunks.length > 0);
      const emittedCall = toolCallChunks[0].message?.tool_calls?.[0];
      assert.equal(emittedCall?.function?.name, "workspace_write_file");
      assert.deepEqual(emittedCall?.function?.arguments, {
        path: "test.svg",
        content: "<svg></svg>"
      });
    });

    it("parses non-delta choices[0].message.tool_calls when server sends whole message block", async () => {
      globalThis.fetch = (async () => {
        return createMockSseResponse([
          'data: {"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call_2","type":"function","function":{"name":"fetch_webpage_markdown","arguments":"{\\"url\\":\\"https://example.com\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n'
        ]);
      }) as any;

      const provider = new LlamaCppProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.streamChat("http://127.0.0.1:8080", {
        messages: [{ role: "user", content: "Look up example.com" }]
      })) {
        chunks.push(chunk);
      }

      const toolCallChunks = chunks.filter((c) => c.message?.tool_calls);
      assert.ok(toolCallChunks.length > 0);
      assert.equal(toolCallChunks[0].message?.tool_calls?.[0]?.function?.name, "fetch_webpage_markdown");
      assert.deepEqual(toolCallChunks[0].message?.tool_calls?.[0]?.function?.arguments, {
        url: "https://example.com"
      });
    });

    it("uses LLAMACPP_BASE_URL when defined in environment", async () => {
      process.env.LLAMACPP_BASE_URL = "http://llama-server.internal:8082/";
      let calledUrl = "";
      globalThis.fetch = (async (url: string | URL | Request) => {
        calledUrl = String(url);
        return createMockSseResponse(['data: [DONE]\n\n']);
      }) as any;

      const provider = new LlamaCppProvider();
      for await (const _ of provider.streamChat("http://127.0.0.1:11434", { messages: [] })) {}

      assert.equal(calledUrl, "http://llama-server.internal:8082/v1/chat/completions");
    });
  });

  describe("Task 4: Integration in web-ui/app/api/chat/route.ts", () => {
    it("imports getLLMProvider and delegates streamOllamaChat to provider.streamChat", () => {
      const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
      const content = fs.readFileSync(routePath, "utf8");

      assert.ok(
        content.includes('getLLMProvider') && (content.includes('@/lib/llm/provider') || content.includes('../lib/llm/provider') || content.includes('lib/llm/provider')),
        "route.ts must import getLLMProvider from provider module"
      );

      assert.ok(
        content.includes('getLLMProvider().streamChat') ||
        content.includes('getLLMProvider(') ||
        content.includes('streamLLMChat'),
        "route.ts streamOllamaChat must delegate to LLMProvider.streamChat"
      );
    });
  });

  describe("Task 5: LLMProvider.chat non-streaming convenience wrapper", () => {
    it("OllamaProvider.chat delegates to streamChat and accumulates content, thinking, and tool_calls", async () => {
      globalThis.fetch = (async () => {
        return createMockNdjsonResponse([
          JSON.stringify({ message: { role: "assistant", content: "Part 1, " }, done: false }) + "\n",
          JSON.stringify({ message: { role: "assistant", thinking: "Deep thought" }, done: false }) + "\n",
          JSON.stringify({
            message: {
              role: "assistant",
              content: "Part 2",
              tool_calls: [{ function: { name: "test_tool", arguments: { a: 1 } } }]
            },
            done: true
          }) + "\n"
        ]);
      }) as any;

      const provider = new OllamaProvider();
      const res = await (provider as any).chat("http://127.0.0.1:11434", {
        messages: [{ role: "user", content: "Hi" }]
      });

      assert.equal(res.done, true);
      assert.equal(res.message?.role, "assistant");
      assert.equal(res.message?.content, "Part 1, Part 2");
      assert.equal(res.message?.thinking, "Deep thought");
      assert.equal(res.message?.tool_calls?.length, 1);
      assert.equal(res.message?.tool_calls?.[0]?.function?.name, "test_tool");
    });

    it("LlamaCppProvider.chat delegates to streamChat and accumulates content, thinking, and tool_calls", async () => {
      globalThis.fetch = (async () => {
        return createMockSseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"Solving..."}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Answer is "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"42"}}]}\n\n',
          'data: [DONE]\n\n'
        ]);
      }) as any;

      const provider = new LlamaCppProvider();
      const res = await (provider as any).chat("http://127.0.0.1:8080", {
        messages: [{ role: "user", content: "What is the answer?" }]
      });

      assert.equal(res.done, true);
      assert.equal(res.message?.content, "Answer is 42");
      assert.equal(res.message?.thinking, "Solving...");
    });
  });

  describe("Task 6: LLMProvider.generate method", () => {
    it("OllamaProvider.generate sends to /api/generate and returns GenerateResult with thinking chunks", async () => {
      let sentUrl = "";
      let sentBody: any = null;
      const thinkingChunks: string[] = [];

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        sentUrl = String(url);
        sentBody = JSON.parse(String(init?.body || "{}"));
        return createMockNdjsonResponse([
          JSON.stringify({ response: "<think>Analyzing", done: false }) + "\n",
          JSON.stringify({ response: " problem</think>Here is the fix", done: false }) + "\n",
          JSON.stringify({ response: "!", done: true, total_duration: 50_000_000, load_duration: 10_000_000 }) + "\n"
        ]);
      }) as any;

      const provider = new OllamaProvider();
      const res = await (provider as any).generate({
        model: "swift-15-27b-mtp",
        prompt: "Fix the bug",
        options: { num_predict: 2048 },
        reasoningEffort: "fast",
        onThinkingChunk: (chunk: string) => thinkingChunks.push(chunk)
      }, "http://127.0.0.1:11434");

      assert.equal(sentUrl, "http://127.0.0.1:11434/api/generate");
      assert.equal(sentBody.model, "swift-15-27b-mtp");
      assert.equal(sentBody.stream, true);
      assert.equal(sentBody.options?.num_predict, 2048 + 1024); // requested + fast thinking budget
      assert.ok(res.text.includes("Here is the fix!"));
      assert.ok(thinkingChunks.length > 0);
      assert.equal(res.totalDurationMs, 50);
      assert.equal(res.loadDurationMs, 10);
    });

    it("LlamaCppProvider.generate sends to /v1/chat/completions with n_keep, max_tokens, signal, and thinking chunks", async () => {
      let sentUrl = "";
      let sentBody: any = null;
      let receivedSignal: any = null;
      const thinkingChunks: string[] = [];

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        sentUrl = String(url);
        sentBody = JSON.parse(String(init?.body || "{}"));
        receivedSignal = init?.signal;
        return createMockSseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"Drafting solution"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"const x = 1;"}}]}\n\n',
          'data: [DONE]\n\n'
        ]);
      }) as any;

      const provider = new LlamaCppProvider();
      const abortController = new AbortController();
      const res = await (provider as any).generate({
        model: "qwen-27b",
        prompt: "Write a TS constant",
        options: { num_predict: 512, n_keep: 128 },
        signal: abortController.signal,
        onThinkingChunk: (chunk: string) => thinkingChunks.push(chunk)
      }, "http://127.0.0.1:8080");

      assert.equal(sentUrl, "http://127.0.0.1:8080/v1/chat/completions");
      assert.equal(sentBody.model, "qwen-27b");
      assert.equal(sentBody.max_tokens, 512);
      assert.equal(sentBody.n_keep, 128);
      assert.ok(receivedSignal);
      assert.equal(res.text, "const x = 1;");
      assert.equal(res.thinking, "Drafting solution");
      assert.deepEqual(thinkingChunks, ["Drafting solution"]);
    });
  });

  describe("Task 7: LLMProvider.listModels", () => {
    it("OllamaProvider.listModels queries /api/tags and returns model list", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({
          models: [{ name: "swift-15-27b-mtp:latest" }, { name: "all-minilm:latest" }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as any;

      const provider = new OllamaProvider();
      const models = await (provider as any).listModels("http://127.0.0.1:11434");
      assert.equal(capturedUrl, "http://127.0.0.1:11434/api/tags");
      assert.deepEqual(models, ["swift-15-27b-mtp:latest", "all-minilm:latest"]);
    });

    it("LlamaCppProvider.listModels queries /v1/models and returns model list", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({
          data: [{ id: "qwen-27b" }, { id: "deepseek-coder" }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as any;

      const provider = new LlamaCppProvider();
      const models = await (provider as any).listModels("http://127.0.0.1:8080");
      assert.equal(capturedUrl, "http://127.0.0.1:8080/v1/models");
      assert.deepEqual(models, ["qwen-27b", "deepseek-coder"]);
    });
  });

  describe("Task 8: LLMProvider.healthCheck & ensureResident", () => {
    it("OllamaProvider.healthCheck returns true on 200 and false on network failure", async () => {
      const provider = new OllamaProvider();

      globalThis.fetch = (async () => new Response("{\"version\":\"0.5.1\"}", { status: 200 })) as any;
      const ok = await (provider as any).healthCheck("http://127.0.0.1:11434");
      assert.equal(ok, true);

      globalThis.fetch = (async () => { throw new Error("Connection refused"); }) as any;
      const fail = await (provider as any).healthCheck("http://127.0.0.1:11434");
      assert.equal(fail, false);
    });

    it("LlamaCppProvider.healthCheck returns true on 200 and false on network failure", async () => {
      const provider = new LlamaCppProvider();

      globalThis.fetch = (async () => new Response("{\"status\":\"ok\"}", { status: 200 })) as any;
      const ok = await (provider as any).healthCheck("http://127.0.0.1:8080");
      assert.equal(ok, true);

      globalThis.fetch = (async () => { throw new Error("Connection refused"); }) as any;
      const fail = await (provider as any).healthCheck("http://127.0.0.1:8080");
      assert.equal(fail, false);
    });

    it("OllamaProvider.ensureResident posts /api/generate with keep_alive: -1", async () => {
      let capturedBody: any = null;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body || "{}"));
        return new Response("{}", { status: 200 });
      }) as any;

      const provider = new OllamaProvider();
      const success = await (provider as any).ensureResident("swift-15-27b-mtp", "http://127.0.0.1:11434");
      assert.equal(success, true);
      assert.equal(capturedBody.model, "swift-15-27b-mtp");
      assert.equal(capturedBody.keep_alive, -1);
    });

    it("LlamaCppProvider.ensureResident checks health and returns true when server is ready", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return new Response("{\"status\":\"ok\"}", { status: 200 });
      }) as any;

      const provider = new LlamaCppProvider();
      const success = await (provider as any).ensureResident("qwen-27b", "http://127.0.0.1:8080");
      assert.equal(success, true);
      assert.ok(capturedUrl.includes("/health"));
    });
  });

  describe("Task 9: Call-site integration with workerPool and residency", () => {
    it("createOllamaGenerate delegates to LlamaCppProvider.generate when resolveLLMEngine() is llamacpp", async () => {
      process.env.LLM_ENGINE = "llamacpp";
      let calledUrl = "";
      let requestBody: any = null;

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calledUrl = String(url);
        requestBody = JSON.parse(String(init?.body || "{}"));
        return createMockSseResponse([
          'data: {"choices":[{"delta":{"content":"export const pi = 3.14;"}}]}\n\n',
          'data: [DONE]\n\n'
        ]);
      }) as any;

      const { createOllamaGenerate } = await import("../lib/subagents/llmClient.js");
      const generate = createOllamaGenerate({ baseUrl: "http://127.0.0.1:8080" });
      const result = await generate({
        model: "llama-model",
        prompt: "export pi",
        options: { num_predict: 256 }
      });

      assert.ok(calledUrl.includes("/v1/chat/completions"));
      assert.equal(requestBody.max_tokens, 256);
      assert.equal(result.text, "export const pi = 3.14;");
    });

    it("enforceResidency uses LlamaCppProvider.ensureResident when resolveLLMEngine() is llamacpp", async () => {
      process.env.LLM_ENGINE = "llamacpp";
      let healthChecked = false;

      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("/health")) {
          healthChecked = true;
          return new Response("{\"status\":\"ok\"}", { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as any;

      const { enforceResidency, planResidency } = await import("../lib/subagents/residency.js");
      const plan = planResidency({
        roster: { builder: "swift-15-27b-mtp" },
        modelSizes: { "swift-15-27b-mtp": 16 * 1024 ** 3 },
        vramBudgetBytes: 24 * 1024 ** 3
      });

      const actions = await enforceResidency(plan, "http://127.0.0.1:8080");
      assert.ok(healthChecked, "Must check health on llamacpp endpoint during residency enforcement");
      assert.ok(actions.some((a) => a.includes("llamacpp")), "Actions must record llamacpp provider residency");
    });
  });
});

