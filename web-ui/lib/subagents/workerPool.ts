import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { Milestone, WorkerRole } from "./types";
import {
  createOllamaGenerate,
  isFastGraphTestMode,
  stripCodeFence,
  type GenerateFn
} from "./llmClient";
import { keepAliveFor, type ResidencyPlan } from "./residency";

export interface ModelRosterConfig {
  planner?: string;
  builder?: string;
  critic?: string;
  explorer?: string;
  recorder?: string;
}

export interface WorkerPoolOptions {
  maxConcurrency?: number;
  modelRoster?: ModelRosterConfig;
  /** Injected model client (tests / alternate backends). Defaults to Ollama per worker. */
  generate?: GenerateFn;
  /** Residency plan supplying keep_alive per model (see residency.ts). */
  residencyPlan?: ResidencyPlan;
}

export interface WorkerJob<T = any> {
  role: WorkerRole;
  taskId: string;
  abortSignal?: AbortSignal;
  taskFn: (signal: AbortSignal) => Promise<T>;
}

export interface CriticReview {
  approved: boolean;
  feedback: string[];
  /** True when the critic could not obtain a model verdict and therefore refused to approve. */
  abstained?: boolean;
  /** True when the verdict is rule-only under FAST_GRAPH_TEST (no model consulted). */
  synthetic?: boolean;
  model?: string;
}

export interface BuilderResult {
  diff: string;
  gitSha: string;
  iterations: number;
  /** True only for the FAST_GRAPH_TEST deterministic fallback. */
  synthetic: boolean;
  /** Model that produced the content (undefined when synthetic). */
  model?: string;
  targetFile: string;
  loadDurationMs?: number;
}

export interface RecordSkillResult {
  promoted: boolean;
  skillFilePath?: string;
}

export interface WorkerModelOptions {
  model?: string;
  ollamaUrl?: string;
  generate?: GenerateFn;
  keepAlive?: string | number;
}

export class ExplorerWorker {
  readonly role: WorkerRole = "explorer";
  private readonly scopedTools = [
    "workspace_get_tree",
    "workspace_grep",
    "workspace_read_file"
  ];

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  async exploreWorkspace(options: { path?: string; query?: string }): Promise<string> {
    return `Inventory distillation for ${options.path || "workspace root"}`;
  }
}

/**
 * Resolves the real HEAD SHA. Provenance rule: never synthesize a SHA.
 * Throws when no git repository is found. `strict` only inspects `repoRoot`.
 */
export function getResolvedGitSha(repoRoot?: string, opts?: { strict?: boolean }): string {
  const candidates = (opts?.strict
    ? [repoRoot]
    : [repoRoot, process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")]
  ).filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      const top = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      if (opts?.strict && path.resolve(top).toLowerCase() !== path.resolve(dir).toLowerCase()) continue;
      const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        return sha;
      }
    } catch {}
  }
  throw new Error(`No git repository found (searched: ${candidates.join(", ")}); refusing to fabricate a commit SHA.`);
}

export function createUnifiedDiff(filename: string, oldStr: string, newStr: string): string {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];

  const diffLines: string[] = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`
  ];

  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      diffLines.push(`-${line}`);
    }
  }
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      diffLines.push(`+${line}`);
    } else {
      diffLines.push(` ${line}`);
    }
  }

  return diffLines.join("\n") + "\n";
}

const FORCED_FLAW_MARKER = "// FORCED_FLAW: seeded discrepancy for critic rejection and retry verification";

/**
 * TEST-ONLY deterministic content used exclusively under FAST_GRAPH_TEST.
 * Every result produced from here is flagged `synthetic: true`.
 */
function synthesizeForFastGraphTest(milestone: Milestone, targetRelPath: string, previousContent: string, criticFeedback: string[], iteration: number): string {
  let content = previousContent;
  if (criticFeedback.length > 0) {
    for (const fb of criticFeedback) {
      if (fb.includes("egress-mesh") && !content.includes("egress-mesh")) {
        content += "\n// Network configuration: browser-mcp attached to egress-mesh\nexport const SCRAPER_NETWORK = 'egress-mesh';";
      }
      if ((fb.includes("#ffffff") || fb.includes("background")) && !content.includes("#ffffff")) {
        content += "\nexport const CANVAS_BACKGROUND = '#ffffff';";
      }
    }
    if (content === previousContent) {
      content += `\n// [synthetic] refinement iteration ${iteration}`;
    }
    return content;
  }
  return `// [synthetic FAST_GRAPH_TEST output] ${milestone.id}: ${milestone.title}\n// target: ${targetRelPath}\nexport interface ${milestone.id.replace(/[^A-Za-z0-9_]/g, "_")}TaskResult {\n  id: string;\n  status: string;\n}\n`;
}

export class BuilderWorker {
  readonly role: WorkerRole = "builder";
  readonly maxIterations: number = 5;
  private readonly model?: string;
  private readonly injectedGenerate?: GenerateFn;
  private readonly ollamaUrl?: string;
  private readonly keepAlive?: string | number;
  private readonly scopedTools = [
    "workspace_write_file",
    "workspace_run_command",
    "git_diff",
    "git_commit"
  ];

  constructor(options?: WorkerModelOptions) {
    this.model = options?.model;
    this.injectedGenerate = options?.generate;
    this.ollamaUrl = options?.ollamaUrl;
    this.keepAlive = options?.keepAlive;
  }

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  private resolveTarget(milestone: Milestone, explicit?: string): string {
    let target =
      explicit ||
      milestone.plannedFiles?.[0] ||
      milestone.acceptanceCriteria?.find((c) => c.fileMatch)?.fileMatch ||
      `workspace/lib/${milestone.id.toLowerCase()}.ts`;
    const protectedCoreFiles = ["docker-compose.yml", "package.json", "package-lock.json", "README.md", "tsconfig.json"];
    if (protectedCoreFiles.includes(target) && !explicit && !milestone.plannedFiles?.includes(target)) {
      target = `docs/generated/${target}`;
    }
    return target;
  }

  async executeMilestoneWork(
    milestone: Milestone,
    options?: {
      repoRoot?: string;
      previousDiff?: string;
      criticFeedback?: string[];
      iteration?: number;
      targetFile?: string;
      model?: string;
      gitSha?: string;
      signal?: AbortSignal;
    }
  ): Promise<BuilderResult> {
    const repoRoot = options?.repoRoot || (fs.existsSync(path.join(process.cwd(), "deploy")) ? process.cwd() : path.resolve(process.cwd(), ".."));
    const iteration = options?.iteration ?? (milestone.builderIterations ? milestone.builderIterations + 1 : 1);
    const modelToUse = options?.model || this.model || process.env.BUILDER_MODEL || "gemma4:e4b";
    const criticFeedback = options?.criticFeedback || [];
    const targetRelPath = this.resolveTarget(milestone, options?.targetFile);

    const fullPath = path.resolve(repoRoot, targetRelPath);
    const previousContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";

    // Deterministic fallback is permitted ONLY in FAST_GRAPH_TEST mode with no injected model.
    const synthetic = !this.injectedGenerate && isFastGraphTestMode();
    let newContent: string;
    let loadDurationMs: number | undefined;

    if (synthetic) {
      newContent = synthesizeForFastGraphTest(milestone, targetRelPath, previousContent.replace(`\n${FORCED_FLAW_MARKER}`, ""), criticFeedback, iteration);
    } else {
      const generate = this.injectedGenerate || createOllamaGenerate({ baseUrl: this.ollamaUrl });
      const prompt = `You are an expert autonomous code builder working on milestone [${milestone.id}]: ${milestone.title}.
Your task: generate the exact, complete, production-grade file content for "${targetRelPath}".
Task Requirements:
${milestone.description}
Acceptance Criteria:
${milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}
${criticFeedback.length > 0 ? `\nCRITIC REJECTION FEEDBACK TO RESOLVE IN THIS ITERATION:\n${criticFeedback.join("\n")}` : ""}
${previousContent ? `\nExisting file content to modify:\n${previousContent.replace(`\n${FORCED_FLAW_MARKER}`, "").slice(0, 6000)}` : ""}

Respond ONLY with the complete, raw file content for "${targetRelPath}". Do not wrap in conversational prose or explanation.`;

      // Throws ModelUnavailableError on any failure — nothing is written in that case.
      const result = await generate({
        model: modelToUse,
        prompt,
        keepAlive: this.keepAlive,
        signal: options?.signal,
        options: { temperature: 0.2, num_predict: 4096 }
      });
      newContent = stripCodeFence(result.text);
      loadDurationMs = result.loadDurationMs;
    }

    // Test hook: seed a deterministic flaw on iteration 1 so critic rejection -> retry is provable.
    if (milestone.forcedFlaw && iteration === 1) {
      newContent += `\n${FORCED_FLAW_MARKER}`;
    } else {
      newContent = newContent.replace(`\n${FORCED_FLAW_MARKER}`, "");
    }

    const gitSha = options?.gitSha || getResolvedGitSha(repoRoot);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, newContent, "utf8");

    return {
      diff: createUnifiedDiff(targetRelPath.replace(/\\/g, "/"), previousContent, newContent),
      gitSha,
      iterations: iteration,
      synthetic,
      model: synthetic ? undefined : modelToUse,
      targetFile: targetRelPath,
      loadDurationMs
    };
  }
}

export class CriticWorker {
  readonly role: WorkerRole = "critic";
  private readonly model?: string;
  private readonly injectedGenerate?: GenerateFn;
  private readonly ollamaUrl?: string;
  private readonly keepAlive?: string | number;
  private readonly scopedTools = [
    "workspace_read_file",
    "workspace_grep",
    "git_diff"
  ];

  constructor(options?: WorkerModelOptions) {
    this.model = options?.model;
    this.injectedGenerate = options?.generate;
    this.ollamaUrl = options?.ollamaUrl;
    this.keepAlive = options?.keepAlive;
  }

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  async evaluateMilestoneDiff(
    milestone: Milestone,
    diffContext: { diff: string; filesChanged?: string[] },
    options?: { model?: string; signal?: AbortSignal }
  ): Promise<CriticReview> {
    const feedback: string[] = [];
    const diff = diffContext.diff;
    const modelToUse = options?.model || this.model || process.env.CRITIC_MODEL || "qwen3.8:27b-q3_k_m";

    // 1. Machine-checkable criterion evaluation against diff
    for (const criterion of milestone.acceptanceCriteria) {
      const assertion = criterion.assertion.toLowerCase();

      if (assertion.includes("egress-mesh") && !diff.includes("egress-mesh")) {
        feedback.push(`Criterion [${criterion.id}] violation: Expected network egress-mesh, but diff does not contain egress-mesh.`);
      }

      if (assertion.includes("#ffffff") && !diff.includes("#ffffff") && !diff.includes("background")) {
        feedback.push(`Criterion [${criterion.id}] violation: Expected background=#ffffff in diagram specification.`);
      }

      if (assertion.includes("30") && assertion.includes("cells") && !diff.includes("30") && !diff.includes("mxCells")) {
        feedback.push(`Criterion [${criterion.id}] violation: Expected 30 mxCells in architecture diagram.`);
      }

      if (criterion.fileMatch && !diff.includes(criterion.fileMatch)) {
        feedback.push(`Criterion [${criterion.id}] violation: Diff does not modify expected file matching ${criterion.fileMatch}.`);
      }
    }

    // 2. Forced flaw detection (only on added lines)
    const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
    if (addedLines.includes("FORCED_FLAW") || addedLines.includes("SYNTAX_ERROR") || addedLines.includes("polygon-error")) {
      feedback.push("Forced flaw detected in diff content: intentional violation triggers critic rejection and builder retry.");
    }

    // 3a. TEST-ONLY: rule-based verdict, explicitly flagged synthetic.
    if (!this.injectedGenerate && isFastGraphTestMode()) {
      return { approved: feedback.length === 0, feedback, abstained: false, synthetic: true };
    }

    // 3b. Model review. Any failure to obtain a parseable verdict => abstain (never approve).
    const generate = this.injectedGenerate || createOllamaGenerate({ baseUrl: this.ollamaUrl });
    const prompt = `You are a strict, adversarial code review critic evaluating an autonomous builder's diff.
Milestone: [${milestone.id}] ${milestone.title}
Acceptance Criteria:
${milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}

Diff Under Review:
${diff.slice(0, 6000)}

Critically inspect the diff against each criterion. Reference actual diff lines and content in your verdict.
If any criterion is violated, missing, or has flaws, set approved to false and explain the exact flaw in feedback.
If all criteria are genuinely satisfied, set approved to true.

Respond strictly in JSON:
{
  "approved": boolean,
  "feedback": string[],
  "analysis": "concise explanation referencing diff lines"
}`;

    let verdictText: string;
    try {
      const useJsonFormat = !modelToUse.toLowerCase().includes("gemma");
      const result = await generate({
        model: modelToUse,
        prompt,
        ...(useJsonFormat ? { format: "json" } : {}),
        keepAlive: this.keepAlive,
        signal: options?.signal,
        options: { temperature: 0.1, num_predict: 512 }
      });
      verdictText = result.text;
    } catch (err: any) {
      return {
        approved: false,
        abstained: true,
        synthetic: false,
        model: modelToUse,
        feedback: [...feedback, "critic model unreachable — abstaining", String(err?.message || err)]
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stripCodeFence(verdictText));
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed.approved !== "boolean") {
      return {
        approved: false,
        abstained: true,
        synthetic: false,
        model: modelToUse,
        feedback: [...feedback, "critic model returned an unparseable verdict — abstaining", verdictText.slice(0, 300)]
      };
    }

    if (!parsed.approved) {
      const modelFeedback = Array.isArray(parsed.feedback) ? parsed.feedback.filter((f: unknown) => typeof f === "string" && f.trim()) : [];
      feedback.push(...(modelFeedback.length > 0 ? modelFeedback : [`Model rejected: ${parsed.analysis || "no specifics given"}`]));
    }

    return {
      approved: feedback.length === 0 && parsed.approved === true,
      feedback,
      abstained: false,
      synthetic: false,
      model: modelToUse
    };
  }
}

export class RecorderWorker {
  readonly role: WorkerRole = "recorder";
  private readonly skillsDirectory: string;

  constructor(options?: { skillsDirectory?: string }) {
    this.skillsDirectory =
      options?.skillsDirectory ||
      path.resolve(process.cwd(), "../workspace/.agent/skills");
  }

  async evaluateAndRecordSkill(
    milestone: Milestone,
    outcome: { lesson: string; nonTrivialFlag?: boolean; iterations?: number }
  ): Promise<RecordSkillResult> {
    // Promotion gate: only record fixes that took >= 2 iterations or were flagged non-trivial
    const iters = outcome.iterations ?? milestone.builderIterations;
    const qualifies = iters >= 2 || outcome.nonTrivialFlag === true;
    if (!qualifies) {
      return { promoted: false };
    }

    if (!fs.existsSync(this.skillsDirectory)) {
      fs.mkdirSync(this.skillsDirectory, { recursive: true });
    }

    const safeTitle = milestone.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const filename = `skill-${milestone.id}-${safeTitle}.md`;
    const fullPath = path.join(this.skillsDirectory, filename);

    const skillContent = `---
name: ${milestone.title}
milestoneId: ${milestone.id}
iterations: ${milestone.builderIterations}
recordedAt: ${new Date().toISOString()}
---

# Learned Agent Skill: ${milestone.title}

## Problem & Context
${milestone.description}

## Discovered Solution & Rule
${outcome.lesson}
`;

    fs.writeFileSync(fullPath, skillContent, "utf8");

    return {
      promoted: true,
      skillFilePath: fullPath
    };
  }
}

export class WorkerPool {
  private readonly maxConcurrency: number;
  private readonly modelRoster: ModelRosterConfig;
  readonly generate?: GenerateFn;
  readonly residencyPlan?: ResidencyPlan;
  private activeJobs = new Set<Promise<any>>();

  constructor(options?: WorkerPoolOptions) {
    this.maxConcurrency = options?.maxConcurrency || 2;
    this.modelRoster = options?.modelRoster || resolveModelRosterFromEnv();
    this.generate = options?.generate;
    this.residencyPlan = options?.residencyPlan;
  }

  getActiveWorkerCount(): number {
    return this.activeJobs.size;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  getRoster(): ModelRosterConfig {
    return { ...this.modelRoster };
  }

  getModelForRole(role: WorkerRole | "planner"): string {
    const model = this.modelRoster[role];
    if (!model) throw new Error(`No model configured for role "${role}" (set ${role.toUpperCase()}_MODEL)`);
    return model;
  }

  /** keep_alive for a model per the residency plan (undefined = Ollama default). */
  keepAliveFor(model: string): string | number | undefined {
    return this.residencyPlan ? keepAliveFor(this.residencyPlan, model) : undefined;
  }

  /** Model options for a role: configured model, injected client, residency keep_alive. */
  workerOptionsFor(role: WorkerRole | "planner"): WorkerModelOptions {
    const model = this.getModelForRole(role);
    return { model, generate: this.generate, keepAlive: this.keepAliveFor(model) };
  }

  async executeJob<T>(job: WorkerJob<T>): Promise<T> {
    if (job.abortSignal?.aborted) {
      throw new Error("Worker execution aborted before start");
    }

    const abortController = new AbortController();
    if (job.abortSignal) {
      job.abortSignal.addEventListener("abort", () => {
        abortController.abort();
      });
    }

    let cleanupTracking: () => void = () => {};
    const trackingPromise = new Promise<void>((r) => {
      cleanupTracking = r;
    });
    this.activeJobs.add(trackingPromise);

    try {
      return await job.taskFn(abortController.signal);
    } finally {
      this.activeJobs.delete(trackingPromise);
      cleanupTracking();
    }
  }
}

/** Roster from configuration. Zack chooses models; defaults are only the documented fallback. */
export function resolveModelRosterFromEnv(): ModelRosterConfig {
  return {
    planner: process.env.PLANNER_MODEL || "qwen3.8:27b-q3_k_m",
    builder: process.env.BUILDER_MODEL || "gemma4:e4b",
    critic: process.env.CRITIC_MODEL || "qwen3.8:27b-q3_k_m",
    explorer: process.env.EXPLORER_MODEL || "gemma4:e4b",
    recorder: process.env.RECORDER_MODEL || "gemma4:e4b"
  };
}

export function createExplorerWorker(): ExplorerWorker {
  return new ExplorerWorker();
}

export function createBuilderWorker(options?: WorkerModelOptions): BuilderWorker {
  return new BuilderWorker(options);
}

export function createCriticWorker(options?: WorkerModelOptions): CriticWorker {
  return new CriticWorker(options);
}

export function createRecorderWorker(options?: { skillsDirectory?: string }): RecorderWorker {
  return new RecorderWorker(options);
}
