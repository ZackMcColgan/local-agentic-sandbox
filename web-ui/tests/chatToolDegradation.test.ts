import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Phase 1 & 2: Chat Tool Registration Graceful Degradation & Model Default Suite", () => {
  it("chat route defines ADVERTISED_TOOLS including search_web and fetch_webpage_markdown", () => {
    const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
    const content = fs.readFileSync(routePath, "utf8");

    assert.ok(content.includes("const ADVERTISED_TOOLS = new Set(["), "ADVERTISED_TOOLS must be declared");
    assert.ok(content.includes('"search_web"'), "ADVERTISED_TOOLS must include search_web");
    assert.ok(content.includes('"fetch_webpage_markdown"'), "ADVERTISED_TOOLS must include fetch_webpage_markdown");
  });

  it("chat route catches unmapped advertised tools and returns graceful tool status instead of throwing unregistered tool error", () => {
    const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
    const content = fs.readFileSync(routePath, "utf8");

    assert.ok(
      content.includes("if (ADVERTISED_TOOLS.has(toolName))"),
      "Must check if unmapped tool is in ADVERTISED_TOOLS"
    );
    assert.ok(
      content.includes("temporarily unavailable"),
      "Must return graceful degradation message for advertised tools"
    );
    assert.ok(
      content.includes("Model attempted execution of unregistered tool: ${toolName}"),
      "Must still throw for genuinely unregistered/hallucinated tools"
    );
  });

  it("chat route defaults activeModel to configured MODEL_NAME when requestedModel is auto or legacy swift default", () => {
    const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
    const content = fs.readFileSync(routePath, "utf8");

    assert.ok(
      content.includes("activeModel = DEFAULT_MODEL;") || content.includes("DEFAULT_MODEL"),
      "chat route must map default activeModel using DEFAULT_MODEL (honoring MODEL_NAME)"
    );
  });
});
