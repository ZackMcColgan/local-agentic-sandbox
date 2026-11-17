import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Chat Dispatch — Explicit Composer Mode & Build Prefix Routing", () => {
  function shouldLaunchTask(prompt: string, composerMode: "chat" | "build"): boolean {
    const isBuildPrefix = prompt.trim().toLowerCase().startsWith("/build ");
    return composerMode === "build" || isBuildPrefix;
  }

  it("triggers task launch when composerMode is 'build' regardless of prompt text", () => {
    assert.equal(shouldLaunchTask("explain this architecture", "build"), true);
    assert.equal(shouldLaunchTask("build me a CSV parser", "build"), true);
  });

  it("triggers task launch when prompt starts with '/build ' even in chat mode", () => {
    assert.equal(shouldLaunchTask("/build a new navbar component", "chat"), true);
  });

  it("does NOT trigger task launch in chat mode even for words starting with build/create/implement", () => {
    assert.equal(shouldLaunchTask("build me a CSV parser", "chat"), false);
    assert.equal(shouldLaunchTask("create a React component", "chat"), false);
    assert.equal(shouldLaunchTask("implement user auth", "chat"), false);
    assert.equal(shouldLaunchTask("how do I parse CSVs?", "chat"), false);
  });
});
