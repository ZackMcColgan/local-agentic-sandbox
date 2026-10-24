import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlamaCppProvider } from "../lib/llm/provider";
import { repairAndParsePlanJson } from "../lib/subagents/planner";
import { sanitizeScheduleBranchName } from "../lib/subagents/scheduler";

describe("Flash Work Order #6 — Shakeout Fixes Test Suite", () => {
  describe("P0-1: LlamaCppProvider.generate Token Budgeting & Content Recovery", () => {
    it("allocates max_tokens including thinking budget so reasoning does not starve output", async () => {
      let capturedBody: any = null;
      const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body || "{}"));
        const sseData = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Reasoning..." } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Final answer" } }] })}\n\n`,
          `data: [DONE]\n\n`
        ].join("");
        return new Response(sseData, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      };

      const provider = new LlamaCppProvider();
      const res = await provider.generate(
        {
          model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
          prompt: "Decompose task",
          reasoningEffort: "balanced",
          options: { num_predict: 2048 }
        },
        "http://127.0.0.1:8080",
        { fetchImpl: mockFetch as any }
      );

      assert.equal(res.text, "Final answer");
      assert.ok(capturedBody, "Body must be captured");
      // num_predict (2048) + balanced thinking budget (4096) = 6144
      assert.equal(capturedBody.max_tokens, 6144, "max_tokens must allocate headroom for thinking tokens");
    });

    it("recovers response content from thinkingText if model emitted completion inside reasoning", async () => {
      const mockFetch = async (_url: string | URL | Request, _init?: RequestInit) => {
        // Model emitted output inside reasoning tags but zero content delta
        const sseData = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking... Output:\n```json\n{\"milestones\":[{\"id\":\"M1\",\"title\":\"Test\"}]}\n```" } }] })}\n\n`,
          `data: [DONE]\n\n`
        ].join("");
        return new Response(sseData, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      };

      const provider = new LlamaCppProvider();
      const res = await provider.generate(
        {
          model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
          prompt: "Decompose task"
        },
        "http://127.0.0.1:8080",
        { fetchImpl: mockFetch as any }
      );

      assert.ok(res.text.includes('"milestones"'), "Must recover JSON payload from reasoning content when content is empty");
    });
  });

  describe("P1-2: Resilient Planner JSON Parsing", () => {
    it("successfully parses valid clean JSON", () => {
      const raw = '```json\n{"milestones": [{"id": "M1", "title": "Setup", "description": "Init", "plannedFiles": ["index.ts"]}]}\n```';
      const parsed = repairAndParsePlanJson(raw);
      assert.ok(parsed);
      assert.equal(parsed.milestones.length, 1);
      assert.equal(parsed.milestones[0].id, "M1");
    });

    it("repairs truncated JSON with unclosed brackets and trailing commas", () => {
      const truncated = '{"milestones": [{"id": "M1", "title": "Setup", "description": "Init", "plannedFiles": ["index.ts"],';
      const parsed = repairAndParsePlanJson(truncated);
      assert.ok(parsed);
      assert.equal(parsed.milestones.length, 1);
      assert.equal(parsed.milestones[0].id, "M1");
    });
  });

  describe("P1-1: Scheduler Branch Naming Convention", () => {
    it("sanitizes sched/ branch names to conform with feat/ convention", () => {
      const safe = sanitizeScheduleBranchName("sched-1792822037772-2z8cb");
      assert.ok(safe.startsWith("feat/sched-"));
      assert.match(safe, /^(feat|feature|fix)\/[a-zA-Z0-9._-]+$/);
    });
  });
});
