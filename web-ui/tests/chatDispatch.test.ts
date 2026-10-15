import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBuilderPrompt, BUILDER_PROMPT_REGEX } from "../components/ChatStream";

describe("Chat Dispatch — Builder Intent Detection in ChatStream", () => {
  it("triggers onLaunchTask for 'build me a CSV parser'", () => {
    const prompt = "build me a CSV parser";
    assert.equal(isBuilderPrompt(prompt), true);
  });

  it("triggers onLaunchTask for 'create a React component'", () => {
    const prompt = "create a React component";
    assert.equal(isBuilderPrompt(prompt), true);
  });

  it("triggers onLaunchTask for 'implement user auth'", () => {
    const prompt = "implement user auth";
    assert.equal(isBuilderPrompt(prompt), true);
  });

  it("does NOT trigger onLaunchTask for conversational question: 'how do I parse CSVs?'", () => {
    const prompt = "how do I parse CSVs?";
    assert.equal(isBuilderPrompt(prompt), false);
  });

  it("does NOT trigger onLaunchTask for opinion question: 'what do you think about my architecture?'", () => {
    const prompt = "what do you think about my architecture?";
    assert.equal(isBuilderPrompt(prompt), false);
  });

  it("does NOT trigger onLaunchTask for ambiguous question: 'can you help me with authentication?'", () => {
    const prompt = "can you help me with authentication?";
    assert.equal(isBuilderPrompt(prompt), false);
  });

  it("dispatches to onLaunchTask callback when builder prompt is submitted", async () => {
    let launchedPrompt: string | null = null;
    let launchedAttachments: any = null;

    const onLaunchTask = async (prompt: string, attachments?: any) => {
      launchedPrompt = prompt;
      launchedAttachments = attachments;
    };

    // Simulate dispatch logic from ChatStream.tsx
    const testPrompts = [
      { text: "build me a CSV parser", expectLaunch: true },
      { text: "create a React component", expectLaunch: true },
      { text: "implement user auth", expectLaunch: true },
      { text: "how do I parse CSVs?", expectLaunch: false },
      { text: "what do you think about my architecture?", expectLaunch: false },
      { text: "can you help me with authentication?", expectLaunch: false }
    ];

    for (const item of testPrompts) {
      launchedPrompt = null;
      if (isBuilderPrompt(item.text) && onLaunchTask) {
        await onLaunchTask(item.text, []);
      }
      if (item.expectLaunch) {
        assert.equal(launchedPrompt, item.text, `Expected prompt '${item.text}' to launch task`);
      } else {
        assert.equal(launchedPrompt, null, `Expected prompt '${item.text}' NOT to launch task`);
      }
    }
  });
});
