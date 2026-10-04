import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

test("Stretch Item 1: Worker Modelfiles Specification Suite", async (t) => {
  const root = fs.existsSync(path.join(process.cwd(), "deploy")) ? process.cwd() : path.resolve(process.cwd(), "..");
  const builderPath = path.join(root, "deploy", "modelfiles", "Modelfile.builder");
  const criticPath = path.join(root, "deploy", "modelfiles", "Modelfile.critic");

  await t.test("Builder Modelfile specifies base model, low temperature, and system prompt", () => {
    assert.ok(fs.existsSync(builderPath), "Modelfile.builder must exist");
    const content = fs.readFileSync(builderPath, "utf8");
    assert.ok(content.includes("FROM gemma4:e4b"), "Builder must use gemma4:e4b");
    assert.ok(content.includes("PARAMETER temperature 0.2"), "Builder must use temperature 0.2");
    assert.ok(content.includes("PARAMETER num_ctx 8192"), "Builder must support 8192 context");
    assert.ok(content.includes("SYSTEM"), "Builder must have system instructions");
  });

  await t.test("Critic Modelfile specifies base model, deterministic temperature, and strict JSON verdict prompt", () => {
    assert.ok(fs.existsSync(criticPath), "Modelfile.critic must exist");
    const content = fs.readFileSync(criticPath, "utf8");
    assert.ok(content.includes("FROM qwen3.8:27b-q3_k_m"), "Critic must use resident qwen3.8");
    assert.ok(content.includes("PARAMETER temperature 0.1"), "Critic must use temperature 0.1");
    assert.ok(content.includes('"approved": boolean'), "Critic prompt must specify approved field");
    assert.ok(content.includes('"feedback": string[]'), "Critic prompt must specify feedback field");
  });
});
