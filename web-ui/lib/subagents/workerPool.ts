import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import { Milestone, WorkerRole, AssertionContract, EvidenceItem, ContractAssertionResult, TestSnapshot, RevertResult, TestCounts } from "./types";
import ts from "typescript";
export type { TestSnapshot, RevertResult } from "./types";
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
  loadDurationMs?: number;
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

// Helper: Guard against invalid code AST (TypeScript, JavaScript, Python) before file writes (nexus-agent pattern)
export function validateCodeAst(filePath: string, content: string): { valid: boolean; error?: string } {
  const ext = path.extname(filePath).toLowerCase();

  // 1. TypeScript & JavaScript AST parsing via TypeScript compiler API
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    try {
      const scriptKind =
        ext === ".tsx" ? ts.ScriptKind.TSX :
        ext === ".jsx" ? ts.ScriptKind.JSX :
        ext === ".js" || ext === ".mjs" || ext === ".cjs" ? ts.ScriptKind.JS :
        ts.ScriptKind.TS;

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      );

      const diagnostics = (sourceFile as any).parseDiagnostics || [];
      if (diagnostics.length > 0) {
        const first = diagnostics[0];
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.start || 0);
        const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
        return {
          valid: false,
          error: `Syntax error in ${filePath} [line ${line + 1}, col ${character + 1}]: ${message}`
        };
      }
      return { valid: true };
    } catch (err: any) {
      return { valid: false, error: `AST parser failure: ${err.message}` };
    }
  }

  // 2. Python AST parsing via Python standard library ast module
  if (ext === ".py") {
    try {
      execFileSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
        input: content,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return { valid: true };
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.trim() : (err.message || "Invalid Python syntax");
      return {
        valid: false,
        error: `Python SyntaxError in ${filePath}: ${stderr}`
      };
    }
  }

  // 3. Non-code files (Markdown, JSON, SVG, drawio XML, config) pass through
  return { valid: true };
}

// Guardrail 5 Helper: Normalize error signature by file + line + error type (build-loop pattern)
export function normalizeErrorSignature(filePath: string, errorText: string): string {
  const normFile = path.basename(filePath).toLowerCase();
  const lineMatch = errorText.match(/line\s*(\d+)|\((\d+):|:(\d+):/i);
  const line = lineMatch ? (lineMatch[1] || lineMatch[2] || lineMatch[3]) : "unknown";
  const typeMatch = errorText.match(/\b([A-Z][a-zA-Z]*Error)\b/) || 
                    errorText.match(/(syntax error|parse error|unexpected token|identifier expected)/i);
  const errType = typeMatch ? typeMatch[1].toLowerCase().replace(/\s+/g, "_") : "syntax_error";
  return `${normFile}:${line}:${errType}`;
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
    const modelToUse = options?.model || this.model || process.env.BUILDER_MODEL || "swift-27b-mtp";
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

    // Guardrail 1 & 5: Pre-write AST validation & Error-signature stuck detection (build-loop pattern)
    if (!synthetic) {
      let astCheck = validateCodeAst(targetRelPath, newContent);
      let astAttempts = 1;
      const maxAstRetries = 5;
      const errorSignatures: string[] = [];

      while (!astCheck.valid && astAttempts < maxAstRetries) {
        const signature = normalizeErrorSignature(targetRelPath, astCheck.error || "");
        errorSignatures.push(signature);

        // Guardrail 5: If the SAME signature appears 3 times consecutively, break loop and return "stuck"
        const len = errorSignatures.length;
        if (len >= 3 && errorSignatures[len - 1] === signature && errorSignatures[len - 2] === signature && errorSignatures[len - 3] === signature) {
          return {
            diff: "",
            gitSha: options?.gitSha || getResolvedGitSha(repoRoot),
            iterations: iteration,
            synthetic: false,
            model: modelToUse,
            targetFile: targetRelPath,
            loadDurationMs,
            stuck: true,
            errorSignature: signature,
            feedback: [`Builder stuck: identical error signature (${signature}) repeated 3 consecutive times.`]
          };
        }

        astAttempts++;
        const generate = this.injectedGenerate || createOllamaGenerate({ baseUrl: this.ollamaUrl });
        const correctionPrompt = `You are an expert autonomous code builder working on milestone [${milestone.id}]: ${milestone.title}.
Your previous code generation for "${targetRelPath}" failed syntax validation:
${astCheck.error}

Please fix the syntax error and output the complete, valid, raw file content for "${targetRelPath}". Do not wrap in conversational prose or explanation.`;

        const retryResult = await generate({
          model: modelToUse,
          prompt: correctionPrompt,
          keepAlive: this.keepAlive,
          signal: options?.signal,
          options: { temperature: 0.2, num_predict: 4096 }
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
      loadDurationMs
    };
  }
}

/**
 * Guardrail 2 (Item 2): Blocking-Gate Revert
 * Records test suite baseline before builder attempt
 */
export async function recordTestBaseline(
  repoRoot?: string,
  testCommand?: string,
  options?: { evaluator?: () => Promise<TestSnapshot> }
): Promise<TestSnapshot> {
  if (options?.evaluator) {
    return await options.evaluator();
  }

  const root = repoRoot || process.cwd();
  const cmd = testCommand || "npm test";
  let stdout = "";
  let passCount = 0;
  let failCount = 0;
  const failingTests: string[] = [];

  try {
    stdout = execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch (err: any) {
    stdout = err.stdout || err.message || "";
  }

  const passMatch = stdout.match(/(\d+)\s+pass(?:ing|ed)/i);
  if (passMatch) passCount = parseInt(passMatch[1], 10);
  const failMatch = stdout.match(/(\d+)\s+fail(?:ing|ed)/i);
  if (failMatch) failCount = parseInt(failMatch[1], 10);

  return {
    passCount,
    failCount,
    failingTests,
    timestamp: new Date().toISOString()
  };
}

/**
 * Guardrail 2 (Item 2): Compares test results after builder attempt and reverts uncommitted changes if worse
 */
export async function compareAndRevertIfWorse(
  baseline: TestSnapshot,
  repoRoot?: string,
  testCommand?: string,
  modifiedFiles?: string[],
  options?: { evaluator?: () => Promise<{ passCount: number; failCount: number; failingTests?: string[] }> }
): Promise<RevertResult> {
  const root = repoRoot || process.cwd();
  let afterCounts: { passCount: number; failCount: number; failingTests?: string[] };

  if (options?.evaluator) {
    afterCounts = await options.evaluator();
  } else {
    const afterSnapshot = await recordTestBaseline(root, testCommand);
    afterCounts = {
      passCount: afterSnapshot.passCount,
      failCount: afterSnapshot.failCount,
      failingTests: afterSnapshot.failingTests
    };
  }

  const isWorse = (afterCounts.failCount > baseline.failCount) || (afterCounts.passCount < baseline.passCount);

  if (isWorse) {
    const filesToRevert = modifiedFiles && modifiedFiles.length > 0 ? modifiedFiles : [];
    if (filesToRevert.length > 0) {
      for (const file of filesToRevert) {
        try {
          execSync(`git checkout -- "${file}"`, { cwd: root, stdio: "ignore" });
        } catch {
          const full = path.resolve(root, file);
          if (fs.existsSync(full)) fs.unlinkSync(full);
        }
      }
    } else {
      try {
        execSync("git checkout -- .", { cwd: root, stdio: "ignore" });
        execSync("git clean -fd", { cwd: root, stdio: "ignore" });
      } catch {}
    }

    const logMsg = `Reverted: ${baseline.passCount}→${afterCounts.passCount} pass, ${baseline.failCount}→${afterCounts.failCount} fail`;
    console.warn(`[BLOCKING-GATE REVERT] ${logMsg}. Reason: Fix attempt degraded test suite.`);

    return {
      reverted: true,
      filesReverted: filesToRevert,
      before: { passed: baseline.passCount, failed: baseline.failCount },
      after: { passed: afterCounts.passCount, failed: afterCounts.failCount },
      reason: "Fix attempt degraded test suite",
      logMessage: logMsg
    };
  }

  return {
    reverted: false,
    filesReverted: [],
    before: { passed: baseline.passCount, failed: baseline.failCount },
    after: { passed: afterCounts.passCount, failed: afterCounts.failCount }
  };
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
    diffContext: { diff: string; filesChanged?: string[]; testExitCode?: number; testOutput?: string; noChangeReason?: string },
    options?: { model?: string; signal?: AbortSignal; testExitCode?: number }
  ): Promise<CriticReview> {
    const feedback: string[] = [];
    const diff = diffContext.diff;
    const modelToUse = options?.model || this.model || process.env.CRITIC_MODEL || "swift-27b-mtp";

    // Guardrail 3: Ground-truth override, fail-closed (captain-claw R1 pattern)
    // If test suite exited non-zero, immediately return needs_fix WITHOUT calling the model
    const testExitCode = diffContext.testExitCode ?? options?.testExitCode ?? (milestone.testsFailed && milestone.testsFailed > 0 ? 1 : undefined);
    if (testExitCode !== undefined && testExitCode !== 0) {
      return {
        approved: false,
        feedback: [
          `Ground-truth override (captain-claw R1 pattern): Test suite exited non-zero (exit code ${testExitCode}). Tests are ground truth; model cannot override failing tests. Returning needs_fix immediately.`
        ],
        abstained: false,
        synthetic: false,
        model: modelToUse,
        verdict: "needs_fix"
      };
    }

    // Guardrail 2: No-change gate (captain-claw pattern)
    // If zero files changed but builder claimed changes, reject as no-op unless explicit reason given
    const addedOrRemoved = diff && diff.split("\n").some((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")));
    const hasExplicitNoChange = Boolean(diffContext.noChangeReason && /no changes needed because/i.test(diffContext.noChangeReason));
    if (!addedOrRemoved && !hasExplicitNoChange) {
      return {
        approved: false,
        feedback: [
          "No-change gate rejection (captain-claw pattern): Zero files changed and no diff was produced. The builder must produce a diff or explicitly state 'no changes needed because [reason]'."
        ],
        abstained: false,
        synthetic: false,
        model: modelToUse,
        verdict: "needs_fix"
      };
    }

    const collectedEvidence: EvidenceItem[] = [];
    const contractResults: ContractAssertionResult[] = [];
    const forceEmptyEvidence = (diffContext as any)?.forceEmptyEvidence === true;

    // Item 3: Deliverable Contracts evaluation
    if (milestone.assertions && milestone.assertions.length > 0) {
      for (const assertion of milestone.assertions) {
        let passed = false;
        let evidenceText = "";

        if (assertion.type === "file_exists") {
          const resolvedTarget = path.isAbsolute(assertion.target)
            ? assertion.target
            : path.resolve(process.cwd(), assertion.target);
          passed = fs.existsSync(resolvedTarget) || (diffContext.filesChanged?.includes(assertion.target) ?? false) || diff.includes(assertion.target);
          evidenceText = passed ? `File exists: ${assertion.target}` : `File missing: ${assertion.target}`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "file",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500)
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
          evidenceText = passed ? `Found expected string '${expected}' in ${assertion.target}` : `Missing expected string '${expected}' in ${assertion.target}`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "diff",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500)
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
          evidenceText = passed ? `Verified ${assertion.target} does not contain '${forbidden}'` : `Found forbidden hardcoded value '${forbidden}' in ${assertion.target}`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "diff",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500)
            });
          }
        } else if (assertion.type === "test_passes") {
          const exitZero = (diffContext.testExitCode === 0) || (milestone.testsFailed === 0);
          passed = exitZero;
          evidenceText = passed ? `Test runner '${assertion.target}' passed with exit code 0` : `Test runner '${assertion.target}' failed`;
          if (passed && !forceEmptyEvidence) {
            collectedEvidence.push({
              type: "test",
              ref: assertion.target,
              excerpt: evidenceText.slice(0, 500)
            });
          }
        }

        contractResults.push({ assertion, passed, evidence: evidenceText });
        if (!passed) {
          feedback.push(`Assertion contract failure [${assertion.type}]: ${assertion.description}. Target: ${assertion.target}${assertion.expected ? ` (Expected: ${assertion.expected})` : ""}`);
        }
      }
    } else {
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
      }

    // Collect evidence from matching criteria in diff for legacy mode
    if (!milestone.assertions || milestone.assertions.length === 0) {
      if (!forceEmptyEvidence && diff) {
        const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
        for (const line of addedLines) {
          if (line.includes("egress-mesh") || line.includes("#ffffff") || line.includes("mxCells")) {
            collectedEvidence.push({
              type: "diff",
              ref: milestone.id,
              excerpt: line.trim().slice(0, 500)
            });
          }
        }
        if (collectedEvidence.length === 0 && addedLines.length > 0) {
          collectedEvidence.push({
            type: "diff",
            ref: milestone.id,
            excerpt: addedLines[0].trim().slice(0, 500)
          });
        }
      }
    }

    // Item 5: Evidence Linking Enforcement (Fail-closed)
    // If evidence array is empty, treat as abstain (not approved)
    if (collectedEvidence.length === 0) {
      return {
        approved: false,
        feedback: [...feedback, "Evidence linking check failed: No concrete evidence collected for verdict (fail-closed rule)."],
        abstained: true,
        synthetic: false,
        model: modelToUse,
        verdict: "needs_fix",
        evidence: []
      };
    }

    // 2. Forced flaw detection (only on added lines)
    const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
    if (addedLines.includes("FORCED_FLAW") || addedLines.includes("SYNTAX_ERROR") || addedLines.includes("polygon-error")) {
      feedback.push("Forced flaw detected in diff content: intentional violation triggers critic rejection and builder retry.");
    }

    // 3a. TEST-ONLY: rule-based verdict, explicitly flagged synthetic.
    if (!this.injectedGenerate && isFastGraphTestMode()) {
      return { approved: feedback.length === 0, feedback, abstained: false, synthetic: true, verdict: feedback.length === 0 ? "approved" : "needs_fix", evidence: collectedEvidence, assertions: contractResults };
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

    const isApproved = feedback.length === 0 && parsed.approved === true && (contractResults.length === 0 || contractResults.every((r) => r.passed));
    return {
      approved: isApproved,
      feedback,
      abstained: false,
      synthetic: false,
      model: modelToUse,
      verdict: isApproved ? "approved" : "needs_fix",
      evidence: collectedEvidence,
      assertions: contractResults
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
    planner: process.env.PLANNER_MODEL || "swift-27b-mtp",
    builder: process.env.BUILDER_MODEL || "swift-27b-mtp",
    critic: process.env.CRITIC_MODEL || "swift-27b-mtp",
    explorer: process.env.EXPLORER_MODEL || "swift-27b-mtp",
    recorder: process.env.RECORDER_MODEL || "swift-27b-mtp"
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
