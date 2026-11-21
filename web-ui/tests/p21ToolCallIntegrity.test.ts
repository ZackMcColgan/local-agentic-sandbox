import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { buildLayer1Tools, buildToolRegistry, describeTool } from "../lib/progressiveTools";
import { parseToolCallsFromText } from "../lib/toolParser";
import { NextRequest } from "next/server";
import { ThreadStore } from "../lib/threads/threadStore";
import { POST } from "../app/api/chat/route";

type OllamaRequestBody = {
  messages?: Array<{ role?: string; content?: string }>;
};

function startMockOllamaServer(
  handler: (callIndex: number, body: OllamaRequestBody, res: http.ServerResponse) => void
): Promise<{ server: http.Server; url: string }> {
  let callIndex = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:32b" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const idx = callIndex++;
      let body: OllamaRequestBody = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      handler(idx, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("P2.1: Tool-call integrity", () => {
  it("progressiveTools: preserves properties and required fields via Layer 2 on-demand resolution; Layer 1 stays open-schema", () => {
    const tools = [
      {
        name: "workspace_read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            start_line: { type: "number" },
          },
          required: ["path"],
        },
      },
    ];
    const layer1 = buildLayer1Tools(tools);
    const readTool = layer1.find((t) => t.function?.name === "workspace_read_file");
    assert.ok(readTool, "workspace_read_file should be in layer1");
    assert.ok(
      readTool.function.description.length <= 120,
      "layer1 description must be <= 120 chars"
    );
    assert.equal(
      readTool.function.parameters.type,
      "object",
      "layer1 parameters.type must be object"
    );
    assert.equal(
      "properties" in readTool.function.parameters,
      false,
      "layer1 must not include properties"
    );
    assert.equal(
      "required" in readTool.function.parameters,
      false,
      "layer1 must not include required"
    );

    const registry = buildToolRegistry(tools);
    const layer2Read = describeTool("workspace_read_file", registry);
    assert.ok(layer2Read.tool, "workspace_read_file should resolve via Layer 2");
    assert.ok(
      layer2Read.tool.parameters,
      "workspace_read_file Layer 2 tool should have parameters"
    );
    assert.deepEqual(
      layer2Read.tool.parameters.properties,
      tools[0].inputSchema.properties,
      "properties must survive progressive disclosure"
    );
    assert.deepEqual(
      layer2Read.tool.parameters.required,
      ["path"],
      "required must survive progressive disclosure"
    );

    const layer2Search = describeTool("search_web", registry);
    assert.ok(layer2Search.tool, "search_web should resolve via Layer 2");
    assert.ok(layer2Search.tool.parameters, "search_web Layer 2 tool should have parameters");
    assert.deepEqual(
      layer2Search.tool.parameters.required,
      ["query"],
      "search_web required: ['query'] must resolve via Layer 2"
    );
  });

  it("toolParser: handles whitespace and balanced braces with nested objects/braces in strings", () => {
    const allowed = new Set(["workspace_write_file"]);
    const text = `Here is the call:\n  <tool_call>  \n  { "name": "workspace_write_file", "arguments": { "path": "a.ts", "content": "function f() { return { a: 1 }; }" } }  \n  </tool_call>  `;
    const calls = parseToolCallsFromText(text, allowed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, "workspace_write_file");
    assert.equal(calls[0].function.arguments.path, "a.ts");
    assert.equal(calls[0].function.arguments.content, "function f() { return { a: 1 }; }");
  });

  describe("chat route tool-call execution", () => {
    let tmpThreadsDir: string;
    let originalThreadsDir: string | undefined;
    let originalLlmUrl: string | undefined;
    let originalOllamaUrl: string | undefined;
    let originalLlmProvider: string | undefined;
    let mockServer: http.Server | null = null;

    beforeEach(() => {
      tmpThreadsDir = path.join(
        os.tmpdir(),
        `p21-threads-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      );
      fs.mkdirSync(tmpThreadsDir, { recursive: true });
      originalThreadsDir = process.env.THREADS_DIR;
      originalLlmUrl = process.env.LLM_BASE_URL;
      originalOllamaUrl = process.env.OLLAMA_BASE_URL;
      originalLlmProvider = process.env.LLM_PROVIDER;
      process.env.THREADS_DIR = tmpThreadsDir;
      process.env.LLM_PROVIDER = "ollama";
    });

    afterEach(async () => {
      if (mockServer) {
        await new Promise<void>((r) => mockServer!.close(() => r()));
        mockServer = null;
      }
      if (originalThreadsDir === undefined) delete process.env.THREADS_DIR;
      else process.env.THREADS_DIR = originalThreadsDir;
      if (originalLlmUrl === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = originalLlmUrl;
      if (originalOllamaUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = originalOllamaUrl;
      if (originalLlmProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = originalLlmProvider;
      fs.rmSync(tmpThreadsDir, { recursive: true, force: true });
    });

    it("malformed-JSON tool arguments produce a real tool error, never silent {}", async () => {
      let seenToolResult = "";
      const { server, url } = await startMockOllamaServer((callIndex, body, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (callIndex === 0) {
          res.write(
            JSON.stringify({
              model: "qwen2.5-coder:32b",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "tc_bad", function: { name: "search_web", arguments: "{bad json" } },
                ],
              },
              done: true,
              done_reason: "stop",
            }) + "\n"
          );
        } else {
          const toolMsgs = (body.messages || []).filter((m) => m.role === "tool");
          seenToolResult = toolMsgs.map((m) => m.content || "").join("\n");
          res.write(
            JSON.stringify({
              model: "qwen2.5-coder:32b",
              message: { role: "assistant", content: "Handled error." },
              done: true,
              done_reason: "stop",
            }) + "\n"
          );
        }
        res.end();
      });
      mockServer = server;
      process.env.LLM_BASE_URL = url;
      process.env.OLLAMA_BASE_URL = url;

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.createThread({ title: "malformed json test" });
      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: thread.id,
          messages: [{ role: "user", content: "Search" }],
        }),
      });
      const resp = await POST(req);
      await resp.text();
      assert.ok(
        /malformed|invalid json|parse/i.test(seenToolResult),
        `Expected real tool error for malformed JSON arguments, got: ${JSON.stringify(seenToolResult)}`
      );
    });

    it("parallel tool calls in one round all execute", async () => {
      let toolMsgCount = 0;
      const { server, url } = await startMockOllamaServer((callIndex, body, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (callIndex === 0) {
          res.write(
            JSON.stringify({
              model: "qwen2.5-coder:32b",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "tc_p1", function: { name: "search_web", arguments: { query: "q1" } } },
                  { id: "tc_p2", function: { name: "search_web", arguments: { query: "q2" } } },
                ],
              },
              done: true,
              done_reason: "stop",
            }) + "\n"
          );
        } else {
          toolMsgCount = (body.messages || []).filter((m) => m.role === "tool").length;
          res.write(
            JSON.stringify({
              model: "qwen2.5-coder:32b",
              message: { role: "assistant", content: "Both done." },
              done: true,
              done_reason: "stop",
            }) + "\n"
          );
        }
        res.end();
      });
      mockServer = server;
      process.env.LLM_BASE_URL = url;
      process.env.OLLAMA_BASE_URL = url;

      const store = new ThreadStore(tmpThreadsDir);
      const thread = await store.createThread({ title: "parallel tools test" });
      const req = new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: thread.id,
          messages: [{ role: "user", content: "Run both" }],
        }),
      });
      const resp = await POST(req);
      await resp.text();
      assert.equal(
        toolMsgCount,
        2,
        `Expected 2 tool results from parallel calls, got ${toolMsgCount}`
      );
    });
  });
});
