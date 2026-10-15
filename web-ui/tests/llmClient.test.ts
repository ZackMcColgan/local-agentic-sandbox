import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOllamaGenerate,
  getContextSizeForScope,
  GenerateRequest
} from "../lib/subagents/llmClient.js";

describe("Addendum 2 — Scope-Based num_ctx in llmClient", () => {
  it("getContextSizeForScope: maps scopes correctly", () => {
    assert.equal(getContextSizeForScope("PROJECT"), 8192);
    assert.equal(getContextSizeForScope("project"), 8192);
    assert.equal(getContextSizeForScope("SCRIPT"), 4096);
    assert.equal(getContextSizeForScope("script"), 4096);
    assert.equal(getContextSizeForScope("SNIPPET"), 4096);
    assert.equal(getContextSizeForScope("snippet"), 4096);
    assert.equal(getContextSizeForScope(undefined), 4096);
    assert.equal(getContextSizeForScope(""), 4096);
  });

  it("Call generate with scope: 'SNIPPET' asserts num_ctx === 4096 in outgoing request", async () => {
    let capturedBody: any = null;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    };

    const generate = createOllamaGenerate({ fetchImpl: mockFetch as any });
    await generate({
      model: "swift-27b-mtp",
      prompt: "generate snippet",
      scope: "SNIPPET"
    });

    assert.ok(capturedBody, "Outgoing request body must be captured");
    assert.ok(capturedBody.options, "Request options must exist");
    assert.equal(capturedBody.options.num_ctx, 4096, "num_ctx must be 4096 for SNIPPET scope");
  });

  it("Call generate with scope: 'PROJECT' asserts num_ctx === 8192 in outgoing request", async () => {
    let capturedBody: any = null;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    };

    const generate = createOllamaGenerate({ fetchImpl: mockFetch as any });
    await generate({
      model: "swift-27b-mtp",
      prompt: "generate project",
      scope: "PROJECT"
    });

    assert.ok(capturedBody, "Outgoing request body must be captured");
    assert.ok(capturedBody.options, "Request options must exist");
    assert.equal(capturedBody.options.num_ctx, 8192, "num_ctx must be 8192 for PROJECT scope");
  });

  it("Call generate with no scope asserts num_ctx === 4096 (safe default)", async () => {
    let capturedBody: any = null;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    };

    const generate = createOllamaGenerate({ fetchImpl: mockFetch as any });
    await generate({
      model: "swift-27b-mtp",
      prompt: "generate default"
    });

    assert.ok(capturedBody, "Outgoing request body must be captured");
    assert.ok(capturedBody.options, "Request options must exist");
    assert.equal(capturedBody.options.num_ctx, 4096, "num_ctx must default to 4096 when no scope is provided");
  });

  it("Explicit caller num_ctx in options overrides default if specified", async () => {
    let capturedBody: any = null;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    };

    const generate = createOllamaGenerate({ fetchImpl: mockFetch as any });
    await generate({
      model: "swift-27b-mtp",
      prompt: "custom options",
      scope: "SNIPPET",
      options: { num_ctx: 16384 }
    });

    assert.ok(capturedBody, "Outgoing request body must be captured");
    assert.equal(capturedBody.options.num_ctx, 16384, "Caller options must override scope default");
  });
});
