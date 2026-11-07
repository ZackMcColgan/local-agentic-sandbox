import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  WorkerPool,
  resolveModelRosterFromEnv
} from "../lib/subagents/workerPool.js";

describe("Phase 2 — Item 4: Model Roster Refresh Suite", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("resolveModelRosterFromEnv defaults all roles to swift-15-27b-mtp", () => {
    delete process.env.BUILDER_MODEL;
    delete process.env.CRITIC_MODEL;
    delete process.env.EXPLORER_MODEL;
    delete process.env.PLANNER_MODEL;
    delete process.env.RECORDER_MODEL;
    delete process.env.MODEL_NAME;

    const roster = resolveModelRosterFromEnv();
    assert.equal(roster.builder, "swift-15-27b-mtp");
    assert.equal(roster.critic, "swift-15-27b-mtp");
    assert.equal(roster.explorer, "swift-15-27b-mtp");
    assert.equal(roster.planner, "swift-15-27b-mtp");
    assert.equal(roster.recorder, "swift-15-27b-mtp");
  });

  it("resolveModelRosterFromEnv honors MODEL_NAME when role-specific env vars are unset", () => {
    delete process.env.BUILDER_MODEL;
    delete process.env.CRITIC_MODEL;
    delete process.env.EXPLORER_MODEL;
    delete process.env.PLANNER_MODEL;
    delete process.env.RECORDER_MODEL;
    process.env.MODEL_NAME = "qwen3.8-flash-next-gyro-gyro-s";

    const roster = resolveModelRosterFromEnv();
    assert.equal(roster.builder, "qwen3.8-flash-next-gyro-gyro-s");
    assert.equal(roster.critic, "qwen3.8-flash-next-gyro-gyro-s");
    assert.equal(roster.explorer, "qwen3.8-flash-next-gyro-gyro-s");
    assert.equal(roster.planner, "qwen3.8-flash-next-gyro-gyro-s");
    assert.equal(roster.recorder, "qwen3.8-flash-next-gyro-gyro-s");
  });

  it("getModelForRole('builder') returns swift-15-27b-mtp", () => {
    delete process.env.MODEL_NAME;
    delete process.env.BUILDER_MODEL;
    const pool = new WorkerPool();
    assert.equal(pool.getModelForRole("builder"), "swift-15-27b-mtp");
  });

  it("getModelForRole('critic') returns swift-15-27b-mtp", () => {
    delete process.env.MODEL_NAME;
    delete process.env.CRITIC_MODEL;
    const pool = new WorkerPool();
    assert.equal(pool.getModelForRole("critic"), "swift-15-27b-mtp");
  });

  it("getModelForRole('explorer') returns swift-15-27b-mtp", () => {
    delete process.env.MODEL_NAME;
    delete process.env.EXPLORER_MODEL;
    const pool = new WorkerPool();
    assert.equal(pool.getModelForRole("explorer"), "swift-15-27b-mtp");
  });

  it("No references to qwen3.8 or gemma4 or hermes3 remain in workerPool.ts", () => {
    const wpPath = path.resolve(process.cwd(), "lib/subagents/workerPool.ts");
    if (fs.existsSync(wpPath)) {
      const content = fs.readFileSync(wpPath, "utf8");
      assert.equal(content.includes("qwen3.8"), false, "Must not reference qwen3.8");
      assert.equal(content.includes("gemma4"), false, "Must not reference gemma4");
      assert.equal(content.includes("hermes3"), false, "Must not reference hermes3");
    }
  });
});
