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
});
