import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webUiRoot = path.resolve(__dirname, "..");

describe("B4: Live meter parity on SSE done", () => {
  it("chat/route.ts includes roundPromptTokens and outputTokens in the SSE done payload", () => {
    const routeSrc = fs.readFileSync(path.join(webUiRoot, "app", "api", "chat", "route.ts"), "utf8");
    const doneMatch = routeSrc.match(/sendEvent\(\{\s*type:\s*"done"[\s\S]*?\}\)/);
    assert.ok(doneMatch, "Expected sendEvent({ type: \"done\", ... }) in chat/route.ts");
    const doneBlock = doneMatch[0];
    assert.ok(doneBlock.includes("roundPromptTokens"), "SSE done payload must include roundPromptTokens");
    assert.ok(doneBlock.includes("outputTokens"), "SSE done payload must include outputTokens");
  });

  it("ChatStream.tsx applies roundPromptTokens and outputTokens from SSE done to the tail assistant message", () => {
    const chatSrc = fs.readFileSync(path.join(webUiRoot, "components", "ChatStream.tsx"), "utf8");
    assert.ok(
      chatSrc.includes("Array.isArray(event.roundPromptTokens)"),
      "ChatStream.tsx done handler must apply event.roundPromptTokens to the tail assistant message"
    );
  });
});
