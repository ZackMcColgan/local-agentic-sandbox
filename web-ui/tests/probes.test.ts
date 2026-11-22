import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { GenerateFn } from "../lib/subagents/llmClient";

function loadFreshRunSycophancyProbe(): typeof import("../lib/subagents/supervisor").runSycophancyProbe {
  const req = createRequire(path.resolve(__dirname, "probes.test.ts"));
  for (const key of Object.keys(req.cache)) {
    const normalized = key.replace(/\\/g, "/");
    if (
      normalized.endsWith("/lib/subagents/supervisor.ts") ||
      normalized.endsWith("/lib/subagents/probes.ts")
    ) {
      delete req.cache[key];
    }
  }
  const mod = req("../lib/subagents/supervisor") as typeof import("../lib/subagents/supervisor");
  return mod.runSycophancyProbe;
}

describe("probes characterization (runSycophancyProbe)", () => {
  let savedFastGraphTest: string | undefined;
  let savedCriticModel: string | undefined;

  beforeEach(() => {
    savedFastGraphTest = process.env.FAST_GRAPH_TEST;
    savedCriticModel = process.env.CRITIC_MODEL;
    delete process.env.FAST_GRAPH_TEST;
    delete process.env.CRITIC_MODEL;
  });

  afterEach(() => {
    if (savedFastGraphTest === undefined) {
      delete process.env.FAST_GRAPH_TEST;
    } else {
      process.env.FAST_GRAPH_TEST = savedFastGraphTest;
    }
    if (savedCriticModel === undefined) {
      delete process.env.CRITIC_MODEL;
    } else {
      process.env.CRITIC_MODEL = savedCriticModel;
    }
  });

  it("returns true immediately in FAST_GRAPH_TEST mode without calling generateFn", async () => {
    process.env.FAST_GRAPH_TEST = "1";
    const runSycophancyProbe = loadFreshRunSycophancyProbe();
    let calls = 0;
    const mockGenerate: GenerateFn = async (req) => {
      calls++;
      return { text: "Success! Approved.", model: req.model };
    };

    const ok = await runSycophancyProbe(mockGenerate);
    assert.equal(ok, true);
    assert.equal(calls, 0);
  });

  it("returns false when model agrees with coder claim (sycophantic response)", async () => {
    const runSycophancyProbe = loadFreshRunSycophancyProbe();
    const mockGenerate: GenerateFn = async (req) => ({
      text: "Success! All good, approved.",
      model: req.model,
    });

    const ok = await runSycophancyProbe(mockGenerate, "test-critic-model");
    assert.equal(ok, false);
  });

  it("returns true when model acknowledges test failure", async () => {
    const runSycophancyProbe = loadFreshRunSycophancyProbe();
    const mockGenerate: GenerateFn = async (req) => ({
      text: "Failed: test suite exited with code 1, cannot approve.",
      model: req.model,
    });

    const ok = await runSycophancyProbe(mockGenerate, "test-critic-model");
    assert.equal(ok, true);
  });

  it("returns true when model explicitly negates success", async () => {
    const runSycophancyProbe = loadFreshRunSycophancyProbe();
    const mockGenerate: GenerateFn = async (req) => ({
      text: "The claim is not success.",
      model: req.model,
    });

    const ok = await runSycophancyProbe(mockGenerate, "test-critic-model");
    assert.equal(ok, true);
  });

  it("catches errors from generateFn and returns false", async () => {
    const runSycophancyProbe = loadFreshRunSycophancyProbe();
    const failingGenerate: GenerateFn = async () => {
      throw new Error("Ollama unreachable");
    };

    const ok = await runSycophancyProbe(failingGenerate, "test-critic-model");
    assert.equal(ok, false);
  });

  it("executes only once per module instance and short-circuits subsequent calls to true", async () => {
    const runSycophancyProbe = loadFreshRunSycophancyProbe();
    let calls = 0;
    const mockGenerate: GenerateFn = async (req) => {
      calls++;
      return { text: "Success! All good.", model: req.model };
    };

    const first = await runSycophancyProbe(mockGenerate, "test-critic-model");
    const second = await runSycophancyProbe(mockGenerate, "test-critic-model");
    assert.equal(first, false);
    assert.equal(second, true);
    assert.equal(calls, 1);
  });

  it("forwards explicit model parameter and falls back to CRITIC_MODEL env var when omitted", async () => {
    const seenModels: string[] = [];

    const probeExplicit = loadFreshRunSycophancyProbe();
    await probeExplicit(async (req) => {
      seenModels.push(req.model);
      return { text: "Failed due to exit code 1", model: req.model };
    }, "explicit-critic-model");

    process.env.CRITIC_MODEL = "env-critic-model";
    const probeFromEnv = loadFreshRunSycophancyProbe();
    await probeFromEnv(async (req) => {
      seenModels.push(req.model);
      return { text: "Failed due to exit code 1", model: req.model };
    });

    assert.deepEqual(seenModels, ["explicit-critic-model", "env-critic-model"]);
  });
});
