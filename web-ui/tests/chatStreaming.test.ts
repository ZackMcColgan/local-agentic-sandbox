import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Helper function tested directly
function parseThinkingAndContent(raw: string): { thought?: string; content: string } {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
  const match = raw.match(thinkRegex);
  if (match) {
    const thought = match[1].trim();
    const content = raw.replace(thinkRegex, "").trim();
    return { thought, content };
  }

  if (raw.includes("<think>")) {
    const parts = raw.split(/<think>/i);
    const beforeThink = parts[0];
    const afterThink = parts.slice(1).join("<think>");
    if (afterThink.includes("</think>")) {
      const sub = afterThink.split(/<\/think>/i);
      return {
        thought: sub[0].trim(),
        content: (beforeThink + "\n" + sub.slice(1).join("</think>")).trim()
      };
    } else {
      return {
        thought: afterThink,
        content: beforeThink.trim()
      };
    }
  }

  return { content: raw };
}

describe("Chat Streaming & Real-Time Thinking Parser Suite", () => {
  it("parses completed <think>...</think> blocks into thought and content", () => {
    const input = "<think>\nLet's plan the architecture.\n1. Add SVG viewer.\n</think>\nHere is the diagram.";
    const parsed = parseThinkingAndContent(input);
    assert.equal(parsed.thought, "Let's plan the architecture.\n1. Add SVG viewer.");
    assert.equal(parsed.content, "Here is the diagram.");
  });

  it("parses live in-progress <think> tokens as they stream before closing tag arrives", () => {
    const streamChunk1 = "<think>I am starting to analyze the prompt";
    const parsed1 = parseThinkingAndContent(streamChunk1);
    assert.equal(parsed1.thought, "I am starting to analyze the prompt");
    assert.equal(parsed1.content, "");

    const streamChunk2 = "<think>I am starting to analyze the prompt\nNow generating vector graphic...";
    const parsed2 = parseThinkingAndContent(streamChunk2);
    assert.equal(parsed2.thought, "I am starting to analyze the prompt\nNow generating vector graphic...");
    assert.equal(parsed2.content, "");
  });

  it("transitions seamlessly from thinking stream to content stream once </think> is closed", () => {
    const fullStream = "<think>Thought complete.</think>\n```xml\n<svg viewBox='0 0 100 100'></svg>\n```";
    const parsed = parseThinkingAndContent(fullStream);
    assert.equal(parsed.thought, "Thought complete.");
    assert.ok(parsed.content.includes("<svg viewBox='0 0 100 100'>"));
  });

  it("handles conversational content without <think> tags gracefully", () => {
    const input = "Hello! How can I assist you with your project today?";
    const parsed = parseThinkingAndContent(input);
    assert.equal(parsed.thought, undefined);
    assert.equal(parsed.content, "Hello! How can I assist you with your project today?");
  });

  it("parses SSE NDJSON data events accurately", () => {
    const sseChunk = 'data: {"type":"token","content":"<think>planning"}\n\ndata: {"type":"token","content":" step 1</think>Done"}\n\n';
    const lines = sseChunk.split("\n\n");
    let accumulated = "";
    for (const line of lines) {
      if (!line.trim().startsWith("data:")) continue;
      const jsonStr = line.replace(/^data:\s*/, "");
      const event = JSON.parse(jsonStr);
      if (event.type === "token") {
        accumulated += event.content;
      }
    }

    const parsed = parseThinkingAndContent(accumulated);
    assert.equal(parsed.thought, "planning step 1");
    assert.equal(parsed.content, "Done");
  });
});
