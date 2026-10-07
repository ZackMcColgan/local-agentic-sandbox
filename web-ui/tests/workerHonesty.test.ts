import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createBuilderWorker, createCriticWorker, getResolvedGitSha } from "../lib/subagents/workerPool.js";
import { ModelUnavailableError, type GenerateFn } from "../lib/subagents/llmClient.js";
import type { Milestone } from "../lib/subagents/types.js";

// Port 1 is never an Ollama server: connection is refused immediately.
const DEAD_OLLAMA = "http://127.0.0.1:1";

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "M1",
    title: "White background",
    description: "Ensure draw.io canvas uses background=#ffffff",
    acceptanceCriteria: [{ id: "AC-1", assertion: "background must be #ffffff" }],
    status: "in_progress",
    builderIterations: 0,
    criticRounds: 0,
    ...overrides
  };
}

const approvingModel: GenerateFn = async (req) => ({
  text: JSON.stringify({ approved: true, feedback: [], analysis: "diff sets background" }),
  model: req.model,
  loadDurationMs: 0,
  totalDurationMs: 1
});

describe("Phase A — Critic never approves without a model verdict (A1)", () => {
  const savedFast = process.env.FAST_GRAPH_TEST;
  afterEach(() => {
    if (savedFast === undefined) delete process.env.FAST_GRAPH_TEST;
    else process.env.FAST_GRAPH_TEST = savedFast;
  });

  it("critic with Ollama down does NOT approve a rule-clean diff — it abstains", async () => {
    delete process.env.FAST_GRAPH_TEST;
    const critic = createCriticWorker({ ollamaUrl: DEAD_OLLAMA, model: "swift-27b-mtp" });
    const review = await critic.evaluateMilestoneDiff(milestone(), { diff: '+ background="#ffffff"' });
    assert.equal(review.approved, false, "unreachable critic model must never approve");
    assert.equal(review.abstained, true);
    assert.ok(review.feedback.some((f) => f.includes("critic model unreachable — abstaining")));
  });

  it("critic abstains when the model returns an unparseable verdict", async () => {
    delete process.env.FAST_GRAPH_TEST;
    const garbage: GenerateFn = async (req) => ({ text: "sure looks fine to me", model: req.model, loadDurationMs: 0, totalDurationMs: 1 });
    const critic = createCriticWorker({ generate: garbage, model: "swift-27b-mtp" });
    const review = await critic.evaluateMilestoneDiff(milestone(), { diff: '+ background="#ffffff"' });
    assert.equal(review.approved, false);
    assert.equal(review.abstained, true);
  });

  it("critic approves only when rules pass AND the model approves", async () => {
    delete process.env.FAST_GRAPH_TEST;
    const critic = createCriticWorker({ generate: approvingModel, model: "swift-27b-mtp" });
    const review = await critic.evaluateMilestoneDiff(milestone(), { diff: '+ background="#ffffff"' });
    assert.equal(review.approved, true);
    assert.equal(review.abstained, false);
    assert.equal(review.synthetic, false);
  });

  it("a model rejection overrides clean rules and its feedback is surfaced", async () => {
    delete process.env.FAST_GRAPH_TEST;
    const rejecting: GenerateFn = async (req) => ({
      text: JSON.stringify({ approved: false, feedback: ["line 3 sets background twice"], analysis: "dup attr" }),
      model: req.model,
      loadDurationMs: 0,
      totalDurationMs: 1
    });
    const critic = createCriticWorker({ generate: rejecting, model: "swift-27b-mtp" });
    const review = await critic.evaluateMilestoneDiff(milestone(), { diff: '+ background="#ffffff"' });
    assert.equal(review.approved, false);
    assert.ok(review.feedback.includes("line 3 sets background twice"));
  });

  it("FAST_GRAPH_TEST rule-only verdicts are flagged synthetic", async () => {
    process.env.FAST_GRAPH_TEST = "1";
    const critic = createCriticWorker({ ollamaUrl: DEAD_OLLAMA });
    const review = await critic.evaluateMilestoneDiff(milestone(), { diff: '+ background="#ffffff"' });
    assert.equal(review.synthetic, true, "rule-only verdict must carry synthetic provenance");
  });
});

describe("Phase A — Builder never synthesizes in production (A2)", () => {
  const savedFast = process.env.FAST_GRAPH_TEST;
  let tmp = "";
  afterEach(() => {
    if (savedFast === undefined) delete process.env.FAST_GRAPH_TEST;
    else process.env.FAST_GRAPH_TEST = savedFast;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  function tempRepo(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-a2-"));
    return tmp;
  }

  it("production + Ollama down → throws ModelUnavailableError and writes nothing", async () => {
    delete process.env.FAST_GRAPH_TEST;
    const repo = tempRepo();
    const builder = createBuilderWorker({ ollamaUrl: DEAD_OLLAMA, model: "swift-27b-mtp" });
    const m = milestone({ title: "Generate architecture diagram", plannedFiles: ["docs/architecture.drawio"] });
    await assert.rejects(builder.executeMilestoneWork(m, { repoRoot: repo, gitSha: "a".repeat(40) }), ModelUnavailableError);
    assert.equal(fs.existsSync(path.join(repo, "docs/architecture.drawio")), false, "no file may be written on model failure");
  });

  it("FAST_GRAPH_TEST fallback output is marked synthetic: true", async () => {
    process.env.FAST_GRAPH_TEST = "1";
    const repo = tempRepo();
    const builder = createBuilderWorker({ ollamaUrl: DEAD_OLLAMA });
    const res = await builder.executeMilestoneWork(milestone({ plannedFiles: ["out.ts"] }), { repoRoot: repo, gitSha: "b".repeat(40) });
    assert.equal(res.synthetic, true);
    assert.equal(res.model, undefined);
  });

  it("model output is written verbatim (fence stripped) with synthetic: false and the model recorded", async () => {
    delete process.env.FAST_GRAPH_TEST;
    const repo = tempRepo();
    const gen: GenerateFn = async (req) => ({ text: "```ts\nexport const BG = '#ffffff';\n```", model: req.model, loadDurationMs: 0, totalDurationMs: 1 });
    const builder = createBuilderWorker({ generate: gen, model: "swift-27b-mtp" });
    const res = await builder.executeMilestoneWork(milestone({ plannedFiles: ["out.ts"] }), { repoRoot: repo, gitSha: "c".repeat(40) });
    assert.equal(res.synthetic, false);
    assert.equal(res.model, "swift-27b-mtp");
    assert.equal(fs.readFileSync(path.join(repo, "out.ts"), "utf8"), "export const BG = '#ffffff';");
    assert.ok(res.diff.includes("+export const BG = '#ffffff';"));
  });
});

describe("Phase A — No fabricated SHAs (A2c)", () => {
  it("getResolvedGitSha throws outside a git repository instead of inventing a SHA", () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    try {
      assert.throws(() => getResolvedGitSha(notRepo, { strict: true }), /no git repository/i);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("getResolvedGitSha resolves repository via WORKSPACE_DIR environment variable when repoRoot is not a git repo", () => {
    const originalEnv = process.env.WORKSPACE_DIR;
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "workspaceroot-"));
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    try {
      const { execSync } = require("child_process");
      execSync("git init", { cwd: tempRepo, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: tempRepo, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: tempRepo, stdio: "ignore" });
      fs.writeFileSync(path.join(tempRepo, "test.txt"), "hello");
      execSync("git add test.txt && git commit -m 'initial'", { cwd: tempRepo, stdio: "ignore" });
      const expectedSha = execSync("git rev-parse HEAD", { cwd: tempRepo, encoding: "utf8" }).trim();

      process.env.WORKSPACE_DIR = tempRepo;
      // In container environment, repoRoot might be /app (not a git repo), but WORKSPACE_DIR is /workspace
      const resolved = getResolvedGitSha(notRepo);
      assert.equal(resolved, expectedSha, "Should resolve SHA from WORKSPACE_DIR candidate");
    } finally {
      process.env.WORKSPACE_DIR = originalEnv;
      fs.rmSync(tempRepo, { recursive: true, force: true });
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
