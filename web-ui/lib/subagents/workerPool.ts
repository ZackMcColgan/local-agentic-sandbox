import fs from "fs";
import path from "path";
import { Milestone, WorkerRole, EvidenceItem, ContractAssertionResult } from "./types";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";
export type { TestSnapshot, RevertResult } from "./types";
import {
  createLlmGenerate,
  isFastGraphTestMode,
  stripCodeFence,
  type GenerateFn,
} from "./llmClient";
import { keepAliveFor, type ResidencyPlan } from "./residency";
import { workspacePatchFile, type PatchItem, type PatchFileResult } from "./patchCore";
import {
  getCurrentSlotLease,
  getSharedSlotScheduler,
  PrioritySlotScheduler,
  SlotPriority,
} from "../slotScheduler";
import {
  scanWorkspaceRepoMap,
  getResolvedGitSha,
  createUnifiedDiff,
  type WorkspaceFileSymbol,
  type WorkspaceRepoMap,
} from "./repoMap";
import {
  synthesizeForFastGraphTest,
  validateCodeAst,
  normalizeErrorSignature,
} from "./codeValidation";
import { recordTestBaseline, compareAndRevertIfWorse } from "./testBaseline";
export {
  workspacePatchFile,
  type PatchItem,
  type PatchFileResult,
  scanWorkspaceRepoMap,
  getResolvedGitSha,
  createUnifiedDiff,
  type WorkspaceFileSymbol,
  type WorkspaceRepoMap,
  validateCodeAst,
  normalizeErrorSignature,
  recordTestBaseline,
  compareAndRevertIfWorse,
};

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
  /** Injected model client (tests / alternate backends). Defaults to local LLM per worker. */
  generate?: GenerateFn;
  /** Residency plan supplying keep_alive per model (see residency.ts). */
  residencyPlan?: ResidencyPlan;
  /** Task scope driving per-request context window (e.g. SNIPPET, SCRIPT, PROJECT). */
  scope?: string;
  /** Optional priority slot scheduler override (defaults to globalThis shared arbiter). */
  scheduler?: PrioritySlotScheduler;
}

export interface WorkerJob<T = unknown> {
  id?: string;
  role: WorkerRole;
  taskId?: string;
  priority?: SlotPriority;
  abortSignal?: AbortSignal;
  worktreeRepoRoot?: string;
  onTerminalState?: (state: "completed" | "aborted" | "failed") => void;
  taskFn: (signal: AbortSignal, worktreePath?: string) => Promise<T>;
}

export interface CriticReview {
  approved: boolean;
  feedback: string[];
  /** True when the critic could not obtain a model verdict and therefore refused to approve. */
  abstained?: boolean;
  /** True when the verdict is rule-only under FAST_GRAPH_TEST (no model consulted). */
  synthetic?: boolean;
  model?: string;
  verdict?: "approved" | "needs_fix";
  evidence?: EvidenceItem[];
  assertions?: ContractAssertionResult[];
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
  modifiedFiles?: string[];
  loadDurationMs?: number;
  thinking?: string;
  rawContent?: string;
  stuck?: boolean;
  errorSignature?: string;
  feedback?: string[];
  noChangeReason?: string;
}

export interface RecordSkillResult {
  promoted: boolean;
  skillFilePath?: string;
}

export interface WorkerModelOptions {
  model?: string;
  llmUrl?: string;
  ollamaUrl?: string;
  generate?: GenerateFn;
  keepAlive?: string | number;
  scope?: string;
  workspaceRoot?: string;
}

export class ExplorerWorker {
  readonly role: WorkerRole = "explorer";
  private readonly scopedTools = ["workspace_get_tree", "workspace_grep", "workspace_read_file"];

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  async exploreWorkspace(options?: {
    path?: string;
    query?: string;
    repoRoot?: string;
    maxFiles?: number;
  }): Promise<WorkspaceRepoMap> {
    const root = options?.path
      ? path.isAbsolute(options.path)
        ? options.path
        : path.resolve(options?.repoRoot || process.cwd(), options.path)
      : options?.repoRoot || process.cwd();
    return scanWorkspaceRepoMap(root, options);
  }
}

const FORCED_FLAW_MARKER =
  "// FORCED_FLAW: seeded discrepancy for critic rejection and retry verification";

export class BuilderWorker {
  readonly role: WorkerRole = "builder";
  readonly maxIterations: number = 5;
  private readonly model?: string;
  private readonly injectedGenerate?: GenerateFn;
  private readonly llmUrl?: string;
  private readonly keepAlive?: string | number;
  private readonly scope?: string;
  private readonly workspaceRoot?: string;
  private readonly scopedTools = [
    "workspace_write_file",
    "workspace_patch_file",
    "workspace_run_command",
    "git_diff",
    "git_commit",
  ];

  constructor(options?: WorkerModelOptions) {
    this.model = options?.model;
    this.injectedGenerate = options?.generate;
    this.llmUrl = options?.llmUrl || options?.ollamaUrl;
    this.keepAlive = options?.keepAlive;
    this.scope = options?.scope;
    this.workspaceRoot = options?.workspaceRoot;
  }

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  resolveTargets(milestone: Milestone): string[] {
    if (
      milestone.plannedFiles &&
      Array.isArray(milestone.plannedFiles) &&
      milestone.plannedFiles.length > 0
    ) {
      const valid = milestone.plannedFiles.filter((f) =>
        Boolean(f && typeof f === "string" && f.trim().length > 0)
      );
      if (valid.length > 0) return valid;
    }
    return [this.resolveTarget(milestone)];
  }

  async patchFile(
    targetRelPath: string,
    patches: Array<PatchItem>,
    options?: { repoRoot?: string } | string
  ): Promise<PatchFileResult> {
    const repoRoot =
      typeof options === "string"
        ? options
        : options?.repoRoot ||
          this.workspaceRoot ||
          (fs.existsSync(path.join(process.cwd(), "deploy"))
            ? process.cwd()
            : path.resolve(process.cwd(), ".."));
    return await workspacePatchFile(repoRoot, targetRelPath, patches);
  }

  private resolveTarget(milestone: Milestone, explicit?: string): string {
    let target =
      explicit ||
      milestone.plannedFiles?.[0] ||
      milestone.acceptanceCriteria?.find((c) => c.fileMatch)?.fileMatch ||
      `workspace/lib/${milestone.id.toLowerCase()}.ts`;
    const protectedCoreFiles = [
      "docker-compose.yml",
      "package.json",
      "package-lock.json",
      "README.md",
      "tsconfig.json",
    ];
    if (
      protectedCoreFiles.includes(target) &&
      !explicit &&
      !milestone.plannedFiles?.includes(target)
    ) {
      target = `docs/generated/${target}`;
    }
    return target;
  }

  private async tryApplySurgicalPatches(
    rawText: string,
    targetRelPath: string,
    fullPath: string,
    previousContent: string,
    repoRoot: string
  ): Promise<string | null> {
    if (!previousContent || !fs.existsSync(fullPath)) return null;
    let parsedPatches: PatchItem[] | null = null;
    try {
      const potentialJson = stripCodeFence(rawText).trim();
      if (potentialJson.startsWith("{") && potentialJson.endsWith("}")) {
        const parsed = JSON.parse(potentialJson);
        if (parsed && Array.isArray(parsed.patches) && parsed.patches.length > 0) {
          parsedPatches = parsed.patches;
        }
      }
    } catch {
      return null;
    }

    if (parsedPatches) {
      try {
        await this.patchFile(targetRelPath, parsedPatches, { repoRoot });
        return fs.readFileSync(fullPath, "utf8");
      } catch (patchErr: unknown) {
        console.warn(
          `[builder] Surgical patch failed for ${targetRelPath}: ${patchErr instanceof Error ? patchErr.message : String(patchErr)}. Falling back to full content or retry.`
        );
      }
    }
    return null;
  }

  private async runSurgicalEditLoop(params: {
    generate: ReturnType<typeof createLlmGenerate>;
    model: string;
    milestone: Milestone;
    targetRelPath: string;
    fullPath: string;
    previousContent: string;
    repoRoot: string;
    criticFeedback: string[];
    priorContext?: string;
    signal?: AbortSignal;
    onThinkingChunk?: (chunk: string, totalThinking: string) => void;
    maxAttempts?: number;
  }): Promise<{ content: string; loadDurationMs: number; thinking?: string }> {
    const maxAttempts = params.maxAttempts ?? 3;
    let totalLoadDuration = 0;
    let lastThinking: string | undefined;
    let lastError = "";
    let lastText = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retryNote = lastError
        ? `\nPREVIOUS PATCH ATTEMPT FAILED (${lastError}). Fix the search string or syntax and return valid JSON patches.\n`
        : "";
      const prompt = `You are an expert autonomous code builder working on milestone [${params.milestone.id}]: ${params.milestone.title}.
Your task: apply surgical search-and-replace patches to the existing file "${params.targetRelPath}".
Task Requirements:
${params.milestone.description}
Acceptance Criteria:
${params.milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}
${params.criticFeedback.length > 0 ? `\nCRITIC REJECTION FEEDBACK TO RESOLVE IN THIS ITERATION:\n${params.criticFeedback.join("\n")}` : ""}
${params.priorContext || ""}${retryNote}
Existing file content:
${params.previousContent.replace(`\n${FORCED_FLAW_MARKER}`, "").slice(0, 6000)}

Respond ONLY with a JSON object of the form:
{"patches": [{"search": "exact existing text", "replace": "replacement text"}]}
Do not rewrite the entire file.`;

      const result = await params.generate({
        model: params.model,
        prompt,
        keepAlive: this.keepAlive,
        signal: params.signal,
        onThinkingChunk: params.onThinkingChunk,
        scope: this.scope,
        reasoningEffort: "balanced",
        options: { temperature: 0.2, num_predict: 4096 },
      });
      if (result.loadDurationMs) totalLoadDuration += result.loadDurationMs;
      if (result.thinking) lastThinking = result.thinking;
      lastText = result.text || "";

      const patched = await this.tryApplySurgicalPatches(
        result.text,
        params.targetRelPath,
        params.fullPath,
        params.previousContent,
        params.repoRoot
      );
      if (patched !== null) {
        return { content: patched, loadDurationMs: totalLoadDuration, thinking: lastThinking };
      }
      lastError = "Output was not valid { patches: [...] } or search string did not match";
      const lease = getCurrentSlotLease();
      if (lease?.shouldPreempt()) {
        await lease.yieldIfPreempted();
      }
    }

    const fenceMatch = lastText.match(/```(?:[a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/);
    const fallbackContent =
      fenceMatch && fenceMatch[1].trim().length > 0 ? fenceMatch[1] : lastText;
    if (fallbackContent.trim().length > 0) {
      fs.mkdirSync(path.dirname(params.fullPath), { recursive: true });
      fs.writeFileSync(params.fullPath, fallbackContent, "utf8");
      return {
        content: fallbackContent,
        loadDurationMs: totalLoadDuration,
        thinking: lastThinking,
      };
    }

    throw new Error(
      `[builder] Surgical patch loop exhausted ${maxAttempts} attempts for ${params.targetRelPath}: ${lastError}`
    );
  }

  async executeMilestoneWork(
    milestone: Milestone,
    optionsOrIteration?:
      | {
          repoRoot?: string;
          previousDiff?: string;
          criticFeedback?: string[];
          iteration?: number;
          targetFile?: string;
          model?: string;
          gitSha?: string;
          signal?: AbortSignal;
          onThinkingChunk?: (chunk: string, totalThinking: string) => void;
        }
      | number,
    legacyCriticFeedback?: string[],
    legacyRepoRoot?: string
  ): Promise<BuilderResult> {
    const options =
      typeof optionsOrIteration === "object" && optionsOrIteration !== null
        ? optionsOrIteration
        : {
            iteration: typeof optionsOrIteration === "number" ? optionsOrIteration : undefined,
            criticFeedback: legacyCriticFeedback,
            repoRoot: legacyRepoRoot,
          };
    const repoRoot =
      options?.repoRoot ||
      this.workspaceRoot ||
      (fs.existsSync(path.join(process.cwd(), "deploy"))
        ? process.cwd()
        : path.resolve(process.cwd(), ".."));
    const iteration =
      options?.iteration ?? (milestone.builderIterations ? milestone.builderIterations + 1 : 1);
    const modelToUse =
      options?.model || this.model || process.env.BUILDER_MODEL || DEFAULT_PRIMARY_MODEL;
    const criticFeedback = options?.criticFeedback || [];
    const targets = options?.targetFile ? [options.targetFile] : this.resolveTargets(milestone);

    // Multi-target sequential execution
    if (targets.length > 1) {
      const modifiedFiles: string[] = [];
      const diffs: string[] = [];
      let totalLoadDuration = 0;
      let lastThinking: string | undefined;
      let lastContent = "";
      const priorFileContexts: Array<{ file: string; content: string }> = [];

      for (const targetRelPath of targets) {
        const lease = getCurrentSlotLease();
        if (lease?.shouldPreempt()) {
          await lease.yieldIfPreempted();
        }
        const fullPath = path.resolve(repoRoot, targetRelPath);
        const previousContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";

        let newContent: string;
        const synthetic = !this.injectedGenerate && isFastGraphTestMode();
        if (synthetic) {
          newContent = synthesizeForFastGraphTest(
            milestone,
            targetRelPath,
            previousContent.replace(`\n${FORCED_FLAW_MARKER}`, ""),
            criticFeedback,
            iteration
          );
        } else {
          const generate =
            this.injectedGenerate || createLlmGenerate({ baseUrl: this.llmUrl, scope: this.scope });
          const priorContext =
            priorFileContexts.length > 0
              ? `\nPreviously generated files in this milestone:\n` +
                priorFileContexts
                  .map((p) => `--- ${p.file} ---\n${p.content.slice(0, 2000)}`)
                  .join("\n\n")
              : "";
          if (previousContent && fs.existsSync(fullPath)) {
            const surgical = await this.runSurgicalEditLoop({
              generate,
              model: modelToUse,
              milestone,
              targetRelPath,
              fullPath,
              previousContent,
              repoRoot,
              criticFeedback,
              priorContext,
              signal: options?.signal,
              onThinkingChunk: options?.onThinkingChunk,
            });
            newContent = surgical.content;
            totalLoadDuration += surgical.loadDurationMs;
            if (surgical.thinking) lastThinking = surgical.thinking;
          } else {
            const prompt = `You are an expert autonomous code builder working on milestone [${milestone.id}]: ${milestone.title}.
Your task: generate the exact, complete, production-grade file content for "${targetRelPath}".
Task Requirements:
${milestone.description}
Acceptance Criteria:
${milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}
${criticFeedback.length > 0 ? `\nCRITIC REJECTION FEEDBACK TO RESOLVE IN THIS ITERATION:\n${criticFeedback.join("\n")}` : ""}
${priorContext}
${previousContent ? `\nExisting file content to modify:\n${previousContent.replace(`\n${FORCED_FLAW_MARKER}`, "").slice(0, 6000)}` : ""}

Provide the complete file content enclosed in a \`\`\` typescript (or appropriate language) code fence. Do not include introductory or concluding conversation.`;

            const result = await generate({
              model: modelToUse,
              prompt,
              keepAlive: this.keepAlive,
              signal: options?.signal,
              onThinkingChunk: options?.onThinkingChunk,
              scope: this.scope,
              reasoningEffort: "balanced",
              options: { temperature: 0.2, num_predict: 8192 },
            });
            newContent = stripCodeFence(result.text);
            if (result.loadDurationMs) totalLoadDuration += result.loadDurationMs;
            if (result.thinking) lastThinking = result.thinking;

            const patched = await this.tryApplySurgicalPatches(
              result.text,
              targetRelPath,
              fullPath,
              previousContent,
              repoRoot
            );
            if (patched !== null) {
              newContent = patched;
            }
          }
        }

        if (!synthetic) {
          const astCheck = validateCodeAst(targetRelPath, newContent);
          if (!astCheck.valid) {
            console.warn(
              `[builder] AST validation warning for ${targetRelPath}: ${astCheck.error}`
            );
          }
        }

        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, newContent, "utf8");

        diffs.push(
          createUnifiedDiff(targetRelPath.replace(/\\/g, "/"), previousContent, newContent)
        );
        modifiedFiles.push(targetRelPath);
        priorFileContexts.push({ file: targetRelPath, content: newContent });
        lastContent = newContent;
      }

      const gitSha = options?.gitSha || getResolvedGitSha(repoRoot);
      return {
        diff: diffs.join("\n\n"),
        gitSha,
        iterations: iteration,
        synthetic: !this.injectedGenerate && isFastGraphTestMode(),
        model: !this.injectedGenerate && isFastGraphTestMode() ? undefined : modelToUse,
        targetFile: targets[0],
        modifiedFiles,
        loadDurationMs: totalLoadDuration || undefined,
        thinking: lastThinking,
        rawContent: lastContent,
      };
    }

    const targetRelPath = targets[0] || this.resolveTarget(milestone, options?.targetFile);
    const fullPath = path.resolve(repoRoot, targetRelPath);
    const previousContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";

    // Deterministic fallback is permitted ONLY in FAST_GRAPH_TEST mode with no injected model.
    const synthetic = !this.injectedGenerate && isFastGraphTestMode();
    let newContent: string;
    let loadDurationMs: number | undefined;
    let builderThinking: string | undefined;

    if (synthetic) {
      console.warn(
        `[BuilderWorker] Warning: FAST_GRAPH_TEST mode active. Engaging deterministic fallback for milestone ${milestone.id}`
      );
      newContent = synthesizeForFastGraphTest(
        milestone,
        targetRelPath,
        previousContent.replace(`\n${FORCED_FLAW_MARKER}`, ""),
        criticFeedback,
        iteration
      );
    } else {
      const generate =
        this.injectedGenerate || createLlmGenerate({ baseUrl: this.llmUrl, scope: this.scope });
      const isSingleArtifact =
        milestone.taskComplexity === "SINGLE_ARTIFACT" || milestone.skipCriticOnValidSyntax;
      if (!isSingleArtifact && previousContent && fs.existsSync(fullPath)) {
        const surgical = await this.runSurgicalEditLoop({
          generate,
          model: modelToUse,
          milestone,
          targetRelPath,
          fullPath,
          previousContent,
          repoRoot,
          criticFeedback,
          signal: options?.signal,
          onThinkingChunk: options?.onThinkingChunk,
        });
        newContent = surgical.content;
        loadDurationMs = surgical.loadDurationMs || undefined;
        builderThinking = surgical.thinking;
      } else {
        const prompt = isSingleArtifact
          ? `You are an expert autonomous code builder working on milestone [${milestone.id}]: ${milestone.title}.
Generate ONLY the requested file. Do NOT create supporting code, project scaffolding, build configs, or API clients. Output the file content directly.
Task Requirements:
${milestone.description}
Acceptance Criteria:
${milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}
${criticFeedback.length > 0 ? `\nCRITIC REJECTION FEEDBACK TO RESOLVE IN THIS ITERATION:\n${criticFeedback.join("\n")}` : ""}

Provide the complete file content enclosed in a markdown code fence (e.g. \`\`\`xml or \`\`\`svg or language appropriate for "${targetRelPath}"). Do not include introductory or concluding conversation.`
          : `You are an expert autonomous code builder working on milestone [${milestone.id}]: ${milestone.title}.
Your task: generate the exact, complete, production-grade file content for "${targetRelPath}".
Task Requirements:
${milestone.description}
Acceptance Criteria:
${milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}
${criticFeedback.length > 0 ? `\nCRITIC REJECTION FEEDBACK TO RESOLVE IN THIS ITERATION:\n${criticFeedback.join("\n")}` : ""}
${previousContent ? `\nExisting file content to modify:\n${previousContent.replace(`\n${FORCED_FLAW_MARKER}`, "").slice(0, 6000)}` : ""}

Provide the complete file content enclosed in a \`\`\` typescript (or appropriate language) code fence. Do not include introductory or concluding conversation.`;

        // Throws ModelUnavailableError on any failure — nothing is written in that case.
        const result = await generate({
          model: modelToUse,
          prompt,
          keepAlive: this.keepAlive,
          signal: options?.signal,
          onThinkingChunk: options?.onThinkingChunk,
          scope: this.scope,
          reasoningEffort: "balanced",
          options: { temperature: 0.2, num_predict: 8192 },
        });
        newContent = stripCodeFence(result.text);
        loadDurationMs = result.loadDurationMs;
        builderThinking = result.thinking;

        const patched = await this.tryApplySurgicalPatches(
          result.text,
          targetRelPath,
          fullPath,
          previousContent,
          repoRoot
        );
        if (patched !== null) {
          newContent = patched;
        }
      }
    }

    // Guardrail 1 & 5: Pre-write AST validation & Error-signature stuck detection (build-loop pattern)
    if (!synthetic) {
      let astCheck = validateCodeAst(targetRelPath, newContent);
      let astAttempts = 1;
      const maxAstRetries = 5;
      const errorSignatures: string[] = [];

      while (!astCheck.valid && astAttempts < maxAstRetries) {
        console.warn(
          `[builder] AST validation failed for ${targetRelPath} (attempt ${astAttempts}): ${astCheck.error}`
        );
        const signature = normalizeErrorSignature(targetRelPath, astCheck.error || "");
        errorSignatures.push(signature);

        // Guardrail 5: If the SAME signature appears 3 times consecutively, break loop and return "stuck"
        const len = errorSignatures.length;
        if (
          len >= 3 &&
          errorSignatures[len - 1] === signature &&
          errorSignatures[len - 2] === signature &&
          errorSignatures[len - 3] === signature
        ) {
          return {
            diff: "",
            gitSha: options?.gitSha || getResolvedGitSha(repoRoot),
            iterations: iteration,
            synthetic: false,
            model: modelToUse,
            targetFile: targetRelPath,
            modifiedFiles: [targetRelPath],
            loadDurationMs,
            stuck: true,
            errorSignature: signature,
            feedback: [
              `Builder stuck: identical error signature (${signature}) repeated 3 consecutive times.`,
            ],
          };
        }

        astAttempts++;
        const generate =
          this.injectedGenerate || createLlmGenerate({ baseUrl: this.llmUrl, scope: this.scope });
        const correctionPrompt = `You are an expert autonomous code builder working on milestone [${milestone.id}]: ${milestone.title}.
Your previous code generation for "${targetRelPath}" failed syntax validation:
${astCheck.error}

Please fix the syntax error and output the complete, valid file content for "${targetRelPath}" enclosed in a markdown code fence (\`\`\`typescript ... \`\`\`). Do not include conversational prose or explanation outside the fence.`;

        const retryResult = await generate({
          model: modelToUse,
          prompt: correctionPrompt,
          keepAlive: this.keepAlive,
          signal: options?.signal,
          scope: this.scope,
          reasoningEffort: "balanced",
          options: { temperature: 0.2, num_predict: 8192 },
        });
        newContent = stripCodeFence(retryResult.text);
        astCheck = validateCodeAst(targetRelPath, newContent);
      }
    }

    // Test hook: seed a deterministic flaw on iteration 1 so critic rejection -> retry is provable.
    if (milestone.forcedFlaw && iteration === 1) {
      newContent += `\n${FORCED_FLAW_MARKER}`;
    } else {
      newContent = newContent.replace(`\n${FORCED_FLAW_MARKER}`, "");
    }

    // Final AST check: reject write if AST is still invalid
    const finalAstCheck = validateCodeAst(targetRelPath, newContent);
    if (!finalAstCheck.valid) {
      throw new Error(`AST validation rejected write to ${targetRelPath}: ${finalAstCheck.error}`);
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
      modifiedFiles: [targetRelPath],
      loadDurationMs,
      thinking: builderThinking,
      rawContent: newContent,
    };
  }
}

export class CriticWorker {
  readonly role: WorkerRole = "critic";
  private readonly model?: string;
  private readonly injectedGenerate?: GenerateFn;
  private readonly llmUrl?: string;
  private readonly keepAlive?: string | number;
  private readonly scope?: string;
  private readonly scopedTools = ["workspace_read_file", "workspace_grep", "git_diff"];

  constructor(options?: WorkerModelOptions) {
    this.model = options?.model;
    this.injectedGenerate = options?.generate;
    this.llmUrl = options?.llmUrl || options?.ollamaUrl;
    this.keepAlive = options?.keepAlive;
    this.scope = options?.scope;
  }

  getScopedToolNames(): string[] {
    return [...this.scopedTools];
  }

  async evaluateMilestoneDiff(
    milestone: Milestone,
    diffContext: {
      diff: string;
      filesChanged?: string[];
      testExitCode?: number;
      testOutput?: string;
      noChangeReason?: string;
    },
    options?: { model?: string; signal?: AbortSignal; testExitCode?: number }
  ): Promise<CriticReview> {
    const feedback: string[] = [];
    const diff = diffContext.diff;
    const modelToUse =
      options?.model || this.model || process.env.CRITIC_MODEL || DEFAULT_PRIMARY_MODEL;

    // Guardrail 3: Ground-truth override, fail-closed (captain-claw R1 pattern)
    // If test suite exited non-zero, immediately return needs_fix WITHOUT calling the model
    const testExitCode =
      diffContext.testExitCode ??
      options?.testExitCode ??
      (milestone.testsFailed && milestone.testsFailed > 0 ? 1 : undefined);
    if (testExitCode !== undefined && testExitCode !== 0) {
      return {
        approved: false,
        feedback: [
          `Ground-truth override (captain-claw R1 pattern): Test suite exited non-zero (exit code ${testExitCode}). Tests are ground truth; model cannot override failing tests. Returning needs_fix immediately.`,
        ],
        abstained: false,
        synthetic: false,
        model: modelToUse,
        verdict: "needs_fix",
      };
    }

    // Guardrail 2: No-change gate (captain-claw pattern)
    // If zero files changed but builder claimed changes, reject as no-op unless explicit reason given
    const addedOrRemoved =
      diff &&
      diff
        .split("\n")
        .some(
          (l) =>
            (l.startsWith("+") && !l.startsWith("+++")) ||
            (l.startsWith("-") && !l.startsWith("---"))
        );
    const hasExplicitNoChange = Boolean(
      diffContext.noChangeReason && /no changes needed because/i.test(diffContext.noChangeReason)
    );
    if (!addedOrRemoved && !hasExplicitNoChange) {
      return {
        approved: false,
        feedback: [
          "No-change gate rejection (captain-claw pattern): Zero files changed and no diff was produced. The builder must produce a diff or explicitly state 'no changes needed because [reason]'.",
        ],
        abstained: false,
        synthetic: false,
        model: modelToUse,
        verdict: "needs_fix",
      };
    }

    const collectedEvidence: EvidenceItem[] = [];
    const contractResults: ContractAssertionResult[] = [];
    const forceEmptyEvidence =
      (diffContext as { forceEmptyEvidence?: boolean } | undefined)?.forceEmptyEvidence === true;

    // Item 3: Deliverable Contracts evaluation
    if (milestone.assertions && milestone.assertions.length > 0) {
      for (const assertion of milestone.assertions) {
        let passed = false;
        let evidenceText = "";

        if (assertion.type === "file_exists") {
          const resolvedTarget = path.isAbsolute(assertion.target)
            ? assertion.target
            : path.resolve(process.cwd(), assertion.target);
          passed =
            fs.existsSync(resolvedTarget) ||
            (diffContext.filesChanged?.includes(assertion.target) ?? false) ||
            diff.includes(assertion.target);
          evidenceText = passed
            ? `File exists: ${assertion.target}`
            : `File missing: ${assertion.target}`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "file",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500),
            });
          }
        } else if (assertion.type === "output_contains") {
          const expected = assertion.expected || "";
          passed = diff.includes(expected);
          if (!passed && fs.existsSync(assertion.target)) {
            try {
              const fileContent = fs.readFileSync(assertion.target, "utf8");
              passed = fileContent.includes(expected);
            } catch {}
          }
          evidenceText = passed
            ? `Found expected string '${expected}' in ${assertion.target}`
            : `Missing expected string '${expected}' in ${assertion.target}`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "diff",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500),
            });
          }
        } else if (assertion.type === "no_hardcoded_values") {
          const forbidden = assertion.expected || "";
          let containsForbidden = diff.includes(forbidden);
          if (!containsForbidden && fs.existsSync(assertion.target)) {
            try {
              const fileContent = fs.readFileSync(assertion.target, "utf8");
              containsForbidden = fileContent.includes(forbidden);
            } catch {}
          }
          passed = !containsForbidden;
          evidenceText = passed
            ? `Verified ${assertion.target} does not contain '${forbidden}'`
            : `Found forbidden hardcoded value '${forbidden}' in ${assertion.target}`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "diff",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500),
            });
          }
        } else if (assertion.type === "test_passes") {
          const exitZero = diffContext.testExitCode === 0 || milestone.testsFailed === 0;
          passed = exitZero;
          evidenceText = passed
            ? `Test runner '${assertion.target}' passed with exit code 0`
            : `Test runner '${assertion.target}' failed`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "test",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500),
            });
          }
        }

        contractResults.push({ assertion, passed, evidence: evidenceText });
        if (!passed) {
          feedback.push(
            `Assertion contract failure [${assertion.type}]: ${assertion.description}. Target: ${assertion.target}${assertion.expected ? ` (Expected: ${assertion.expected})` : ""}`
          );
        }
      }
    } else {
      // 1. Machine-checkable criterion evaluation against diff
      for (const criterion of milestone.acceptanceCriteria) {
        const assertion = criterion.assertion.toLowerCase();

        if (assertion.includes("egress-mesh") && !diff.includes("egress-mesh")) {
          feedback.push(
            `Criterion [${criterion.id}] violation: Expected network egress-mesh, but diff does not contain egress-mesh.`
          );
        }

        if (
          assertion.includes("#ffffff") &&
          !diff.includes("#ffffff") &&
          !diff.includes("background")
        ) {
          feedback.push(
            `Criterion [${criterion.id}] violation: Expected background=#ffffff in diagram specification.`
          );
        }

        if (
          assertion.includes("30") &&
          assertion.includes("cells") &&
          !diff.includes("30") &&
          !diff.includes("mxCells")
        ) {
          feedback.push(
            `Criterion [${criterion.id}] violation: Expected 30 mxCells in architecture diagram.`
          );
        }

        if (criterion.fileMatch && !diff.includes(criterion.fileMatch)) {
          feedback.push(
            `Criterion [${criterion.id}] violation: Diff does not modify expected file matching ${criterion.fileMatch}.`
          );
        }
      }
    }

    // Collect evidence from matching criteria in diff for legacy mode
    if (!milestone.assertions || milestone.assertions.length === 0) {
      if (!forceEmptyEvidence && diff) {
        const addedLines = diff
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
        for (const line of addedLines) {
          if (
            line.includes("egress-mesh") ||
            line.includes("#ffffff") ||
            line.includes("mxCells")
          ) {
            collectedEvidence.push({
              type: "diff",
              ref: milestone.id,
              excerpt: line.trim().slice(0, 500),
            });
          }
        }
        if (collectedEvidence.length === 0 && addedLines.length > 0) {
          collectedEvidence.push({
            type: "diff",
            ref: milestone.id,
            excerpt: addedLines[0].trim().slice(0, 500),
          });
        }
      }
    }

    // Item 5: Evidence Linking Enforcement (Fail-closed)
    // If evidence array is empty, treat as abstain (not approved)
    if (collectedEvidence.length === 0) {
      return {
        approved: false,
        feedback: [
          ...feedback,
          "Evidence linking check failed: No concrete evidence collected for verdict (fail-closed rule).",
        ],
        abstained: true,
        synthetic: false,
        model: modelToUse,
        verdict: "needs_fix",
        evidence: [],
      };
    }

    // 2. Forced flaw detection (only on added lines)
    const addedLines = diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n");
    if (
      addedLines.includes("FORCED_FLAW") ||
      addedLines.includes("SYNTAX_ERROR") ||
      addedLines.includes("polygon-error")
    ) {
      feedback.push(
        "Forced flaw detected in diff content: intentional violation triggers critic rejection and builder retry."
      );
    }

    // 3a. TEST-ONLY: rule-based verdict, explicitly flagged synthetic.
    if (!this.injectedGenerate && isFastGraphTestMode()) {
      console.warn(
        `[CriticWorker] Warning: FAST_GRAPH_TEST mode active. Engaging deterministic rule-based review for milestone ${milestone.id}`
      );
      return {
        approved: feedback.length === 0,
        feedback,
        abstained: false,
        synthetic: true,
        verdict: feedback.length === 0 ? "approved" : "needs_fix",
        evidence: collectedEvidence,
        assertions: contractResults,
      };
    }

    // 3b. Model review. Any failure to obtain a parseable verdict => abstain (never approve).
    const generate =
      this.injectedGenerate || createLlmGenerate({ baseUrl: this.llmUrl, scope: this.scope });
    const prompt = `You are a strict, adversarial code review critic evaluating an autonomous builder's diff.
Milestone: [${milestone.id}] ${milestone.title}
Acceptance Criteria:
${milestone.acceptanceCriteria?.map((c) => `- [${c.id}]: ${c.assertion}`).join("\n")}
${diffContext?.testExitCode !== undefined ? `\nAcceptance Test Runner Status: Exit Code ${diffContext.testExitCode}` : ""}
${diffContext?.testOutput ? `\nTest Output:\n${diffContext.testOutput.slice(-2000)}` : ""}

Diff Under Review:
${diff.slice(0, 16000)}

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
      const useJsonFormat = true;
      const result = await generate({
        model: modelToUse,
        prompt,
        ...(useJsonFormat ? { format: "json" } : {}),
        keepAlive: this.keepAlive,
        signal: options?.signal,
        scope: this.scope,
        reasoningEffort: "balanced",
        options: { temperature: 0.1, num_predict: 2048 },
      });
      verdictText = result.text;
    } catch (err: unknown) {
      console.error(`[CriticWorker] Model evaluation failed for milestone ${milestone.id}:`, err);
      return {
        approved: false,
        abstained: true,
        synthetic: false,
        model: modelToUse,
        feedback: [
          ...feedback,
          "critic model unreachable — abstaining",
          String(err instanceof Error ? err.message : err),
        ],
      };
    }

    let parsed: { approved?: unknown; feedback?: unknown; analysis?: string } | undefined;
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
        feedback: [
          ...feedback,
          "critic model returned an unparseable verdict — abstaining",
          verdictText.slice(0, 300),
        ],
      };
    }

    if (!parsed.approved) {
      const modelFeedback = Array.isArray(parsed.feedback)
        ? parsed.feedback.filter((f: unknown) => typeof f === "string" && f.trim())
        : [];
      feedback.push(
        ...(modelFeedback.length > 0
          ? modelFeedback
          : [`Model rejected: ${parsed.analysis || "no specifics given"}`])
      );
    }

    const isApproved =
      feedback.length === 0 &&
      parsed.approved === true &&
      (contractResults.length === 0 || contractResults.every((r) => r.passed));
    return {
      approved: isApproved,
      feedback,
      abstained: false,
      synthetic: false,
      model: modelToUse,
      verdict: isApproved ? "approved" : "needs_fix",
      evidence: collectedEvidence,
      assertions: contractResults,
    };
  }
}

export class RecorderWorker {
  readonly role: WorkerRole = "recorder";
  private readonly skillsDirectory: string;

  constructor(options?: { skillsDirectory?: string }) {
    this.skillsDirectory =
      options?.skillsDirectory || path.resolve(process.cwd(), "../workspace/.agent/skills");
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
      skillFilePath: fullPath,
    };
  }
}

export class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.permits = Math.max(1, maxConcurrency);
  }

  tryAcquire(): boolean {
    if (this.permits > 0) {
      this.permits--;
      return true;
    }
    return false;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Worker execution aborted before acquiring concurrency slot");
    }
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.queue.indexOf(grant);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error("Worker execution aborted while waiting for concurrency slot"));
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

export class WorkerPool {
  private readonly maxConcurrency: number;
  private readonly semaphore: Semaphore;
  private readonly modelRoster: ModelRosterConfig;
  readonly generate?: GenerateFn;
  readonly residencyPlan?: ResidencyPlan;
  readonly scope?: string;
  private readonly scheduler: PrioritySlotScheduler;
  private readonly explicitMultiConcurrency: boolean;
  private activeJobs = new Set<Promise<unknown>>();

  constructor(options?: WorkerPoolOptions) {
    this.explicitMultiConcurrency =
      typeof options?.maxConcurrency === "number" && options.maxConcurrency > 1;
    this.maxConcurrency =
      options?.maxConcurrency ??
      (process.env.LLM_CONCURRENCY ? parseInt(process.env.LLM_CONCURRENCY, 10) : 1);
    this.semaphore = new Semaphore(this.maxConcurrency);
    this.scheduler = options?.scheduler ?? getSharedSlotScheduler();
    this.modelRoster = options?.modelRoster || resolveModelRosterFromEnv();
    this.generate = options?.generate;
    this.residencyPlan = options?.residencyPlan;
    this.scope = options?.scope;
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
    if (!model)
      throw new Error(`No model configured for role "${role}" (set ${role.toUpperCase()}_MODEL)`);
    return model;
  }

  /** keep_alive for a model per the residency plan (defaults to 24h so models remain in VRAM between prompts). */
  keepAliveFor(model: string): string | number {
    return this.residencyPlan ? keepAliveFor(this.residencyPlan, model) : "24h";
  }

  /** Model options for a role: configured model, injected client, residency keep_alive, task scope. */
  workerOptionsFor(role: WorkerRole | "planner"): WorkerModelOptions {
    const model = this.getModelForRole(role);
    return {
      model,
      generate: this.generate,
      keepAlive: this.keepAliveFor(model),
      scope: this.scope,
    };
  }

  private resolveJobPriority(job: WorkerJob<unknown>): SlotPriority {
    if (job.priority !== undefined) return job.priority;
    if (job.role === "builder") return SlotPriority.P1_BUILDER;
    if (job.role === "recorder") return SlotPriority.P3_HOUSEKEEPING;
    return SlotPriority.P2_ORCHESTRATOR;
  }

  async executeJob<T>(job: WorkerJob<T>): Promise<T> {
    if (job.abortSignal?.aborted) {
      job.onTerminalState?.("aborted");
      throw new Error("Worker execution aborted before start");
    }

    let cleanupTracking: () => void = () => {};
    const trackingPromise = new Promise<void>((r) => {
      cleanupTracking = r;
    });
    this.activeJobs.add(trackingPromise);

    if (this.explicitMultiConcurrency && !this.semaphore.tryAcquire()) {
      try {
        await this.semaphore.acquire(job.abortSignal);
      } catch (err) {
        this.activeJobs.delete(trackingPromise);
        cleanupTracking();
        throw err;
      }
    }

    const abortController = new AbortController();
    let settled = false;
    const emitTerminal = (state: "completed" | "aborted" | "failed") => {
      if (settled) return;
      settled = true;
      job.onTerminalState?.(state);
    };

    const onParentAbort = () => {
      abortController.abort();
    };
    if (job.abortSignal) {
      job.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    let worktreePath: string | undefined;
    if (job.worktreeRepoRoot) {
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { execFileSync } = await import("node:child_process");
      const wtDir = fs.mkdtempSync(path.join(os.default.tmpdir(), "wp-wt-"));
      try {
        execFileSync("git", ["worktree", "add", "--detach", wtDir, "HEAD"], {
          cwd: job.worktreeRepoRoot,
          stdio: "ignore",
        });
        worktreePath = wtDir;
      } catch (err) {
        fs.rmSync(wtDir, { recursive: true, force: true });
        this.activeJobs.delete(trackingPromise);
        cleanupTracking();
        if (this.explicitMultiConcurrency) this.semaphore.release();
        emitTerminal("failed");
        throw err;
      }
    }

    try {
      const runJobBody = async () => {
        const abortPromise = new Promise<never>((_, reject) => {
          if (abortController.signal.aborted) {
            emitTerminal("aborted");
            reject(new Error("Worker execution aborted"));
            return;
          }
          abortController.signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                emitTerminal("aborted");
                reject(new Error("Worker execution aborted"));
              }, 0);
            },
            { once: true }
          );
        });

        const taskPromise = job.taskFn(abortController.signal, worktreePath).then(
          (res) => {
            emitTerminal("completed");
            return res;
          },
          (err) => {
            emitTerminal(abortController.signal.aborted ? "aborted" : "failed");
            throw err;
          }
        );

        return await Promise.race([taskPromise, abortPromise]);
      };

      if (this.explicitMultiConcurrency) {
        return await runJobBody();
      }
      return await this.scheduler.runWithSlot(
        {
          priority: this.resolveJobPriority(job),
          label: `worker:${job.role}:${job.id || job.taskId || "job"}`,
          signal: job.abortSignal,
        },
        runJobBody
      );
    } finally {
      if (job.abortSignal) {
        job.abortSignal.removeEventListener("abort", onParentAbort);
      }
      if (worktreePath && job.worktreeRepoRoot) {
        try {
          const { execFileSync } = await import("node:child_process");
          execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: job.worktreeRepoRoot,
            stdio: "ignore",
          });
        } catch {
          try {
            const fs = await import("node:fs");
            fs.rmSync(worktreePath, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup
          }
        }
      }
      this.activeJobs.delete(trackingPromise);
      cleanupTracking();
      if (this.explicitMultiConcurrency) this.semaphore.release();
    }
  }
}

/** Roster from configuration. The Owner chooses models; defaults are only the documented fallback. */
export function resolveModelRosterFromEnv(): ModelRosterConfig {
  return {
    planner: process.env.PLANNER_MODEL || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL,
    builder: process.env.BUILDER_MODEL || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL,
    critic: process.env.CRITIC_MODEL || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL,
    explorer: process.env.EXPLORER_MODEL || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL,
    recorder: process.env.RECORDER_MODEL || process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL,
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
