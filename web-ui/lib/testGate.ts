import { execSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Canonical workspaces that define "the suite" across the entire repository.
 * Every workspace in root package.json is included: web-ui, mcp-server, browser-mcp.
 */
export const CANONICAL_WORKSPACES = ["web-ui", "mcp-server", "browser-mcp"] as const;
export type CanonicalWorkspace = typeof CANONICAL_WORKSPACES[number];

export interface AffectedTestsResult {
  tests: string[];
  uncoveredFiles: string[];
  ignoredFiles: string[];
}

export interface TestGateOptions {
  changedFiles?: string[];
  budgetSeconds?: number;
  dryRun?: boolean;
  repoRoot?: string;
  sinceRef?: string;
}

export interface TestGateOutcome {
  status: "passed" | "failed";
  exitCode: number;
  passed: number;
  failed: number;
  durationSeconds: number;
  budgetSeconds: number;
  testsRan: string[];
  changedFiles: string[];
  uncoveredFiles: string[];
  error?: string;
  output?: string;
}

/**
 * List of rules mapping file path substrings or regex to associated test suite(s).
 */
interface MappingRule {
  match: (filePath: string) => boolean;
  tests: string[];
}

const MAPPING_RULES: MappingRule[] = [
  // Direct test file changed: run itself
  {
    match: (p) => /tests\/[^/]+\.test\.ts$/.test(p),
    tests: [] // handled dynamically
  },
  // Clipboard utility
  {
    match: (p) => p.includes("lib/clipboard"),
    tests: ["tests/clipboard.test.ts"]
  },
  // SVG utilities and SVG viewer component
  {
    match: (p) => p.includes("lib/svgUtils") || p.includes("components/SvgViewer"),
    tests: [
      "tests/svgRendering.test.ts",
      "tests/svgComponent.test.ts",
      "tests/architectureSvgPair.test.ts"
    ]
  },
  // ChatStream, chatUtils, and chat history components
  {
    match: (p) => p.includes("components/ChatStream") || p.includes("lib/chatUtils"),
    tests: [
      "tests/chatStreaming.test.ts",
      "tests/svgComponent.test.ts",
      "tests/chatHistory.test.ts",
      "tests/frontendRefreshRehydration.test.ts",
      "tests/unifiedUi.test.ts",
      "tests/chatPolish.test.ts"
    ]
  },
  // Unified Agent UI (Material 3) components, threads store & API
  {
    match: (p) =>
      p.includes("lib/threads") ||
      p.includes("app/api/threads") ||
      p.includes("components/LiveRunBlock") ||
      p.includes("components/ModelBottomSheet") ||
      p.includes("components/ThreadsSidebar") ||
      p.includes("tailwind.config") ||
      p.includes("app/layout.tsx"),
    tests: ["tests/unifiedUi.test.ts", "tests/sessionIntegrity.test.ts", "tests/chatPolish.test.ts"]
  },
  {
    match: (p) => p.includes("lib/chatHistory"),
    tests: ["tests/chatHistory.test.ts", "tests/frontendRefreshRehydration.test.ts"]
  },
  // Memory profile, durable facts & semantic memory
  {
    match: (p) => p.includes("lib/memory"),
    tests: ["tests/userProfile.test.ts", "tests/semanticMemory.test.ts"]
  },
  // Skill gate
  {
    match: (p) => p.includes("lib/subagents/skillGate"),
    tests: ["tests/semanticMemory.test.ts"]
  },
  // Chat API route
  {
    match: (p) => p.includes("app/api/chat/route"),
    tests: [
      "tests/chatStreaming.test.ts",
      "tests/agentEngine.test.ts",
      "tests/toolParser.test.ts",
      "tests/fileParser.test.ts",
      "tests/ingestionPipeline.test.ts",
      "tests/userProfile.test.ts",
      "tests/semanticMemory.test.ts"
    ]
  },
  // Tasks API route
  {
    match: (p) => p.includes("app/api/tasks/route"),
    tests: ["tests/tasksApi.test.ts", "tests/activeTaskRehydration.test.ts"]
  },
  // Files API route
  {
    match: (p) => p.includes("app/api/files/route"),
    tests: ["tests/svgRendering.test.ts"]
  },
  // Subagents & Supervisor
  {
    match: (p) => p.includes("lib/subagents/supervisor"),
    tests: [
      "tests/supervisor.test.ts",
      "tests/langgraphSupervisorNodes.test.ts",
      "tests/activeTaskRehydration.test.ts"
    ]
  },
  {
    match: (p) => p.includes("lib/subagents/workerPool"),
    tests: ["tests/workerPool.test.ts", "tests/workerHonesty.test.ts", "tests/langgraphSupervisorNodes.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/llmClient"),
    tests: ["tests/workerHonesty.test.ts", "tests/workerPool.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/residency"),
    tests: ["tests/workerHonesty.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/planner"),
    tests: ["tests/planner.test.ts", "tests/langgraphSupervisorNodes.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/morningReport"),
    tests: ["tests/morningReport.test.ts", "tests/realReportTestCounts.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/types"),
    tests: [
      "tests/supervisor.test.ts",
      "tests/workerPool.test.ts",
      "tests/morningReport.test.ts"
    ]
  },
  // Telemetry, Tool Parser, File Parser
  {
    match: (p) => p.includes("lib/telemetry"),
    tests: ["tests/telemetry.test.ts"]
  },
  {
    match: (p) => p.includes("lib/toolParser"),
    tests: ["tests/toolParser.test.ts"]
  },
  {
    match: (p) => p.includes("lib/fileParser") || p.includes("lib/visionProcessor"),
    tests: ["tests/fileParser.test.ts"]
  },
  // Ingestion
  {
    match: (p) => p.includes("lib/ingestion"),
    tests: ["tests/ingestionPipeline.test.ts"]
  },
  // Models config & modelfiles
  {
    match: (p) => p.includes("config/models") || p.includes("deploy/modelfiles"),
    tests: ["tests/models.test.ts", "tests/modelfiles.test.ts", "tests/agentEngine.test.ts"]
  },
  // Sandbox tier runner
  {
    match: (p) => p.includes("lib/sandbox/tierRunner"),
    tests: ["tests/buildSandboxTier.test.ts"]
  },
  // Oracle ingestion
  {
    match: (p) => p.includes("lib/oracle/ingestion") || p.includes("lib/ingestion"),
    tests: ["tests/ingestionPipeline.test.ts"]
  },
  // Architecture diagram generator
  {
    match: (p) => p.includes("lib/diagram/architectureGenerator"),
    tests: [
      "tests/architectureSvgPair.test.ts",
      "tests/dogfoodPhase1Acceptance.test.ts"
    ]
  },
  // UI views and components
  {
    match: (p) => p.includes("components/MorningReportView"),
    tests: ["tests/morningReport.test.ts", "tests/realReportTestCounts.test.ts"]
  },
  {
    match: (p) =>
      p.includes("components/Navbar") ||
      p.includes("components/WorkerTiles") ||
      p.includes("components/DiffViewer") ||
      p.includes("components/ExecutionTrace") ||
      p.includes("app/page.tsx") ||
      p.includes("app/layout.tsx"),
    tests: [
      "tests/frontendRefreshRehydration.test.ts",
      "tests/chatHistory.test.ts",
      "tests/chatStreaming.test.ts"
    ]
  },
  // MCP server files
  {
    match: (p) => p.startsWith("mcp-server/"),
    tests: ["mcp-server:tests"]
  },
  // Browser MCP files
  {
    match: (p) => p.startsWith("browser-mcp/"),
    tests: ["browser-mcp:tests"]
  },
  // Test gate itself
  {
    match: (p) => p.includes("lib/testGate") || p.includes("scripts/test-gate"),
    tests: ["tests/testGate.test.ts"]
  },
  // Overnight dogfood runner
  {
    match: (p) => p.includes("scripts/run-dogfood-overnight"),
    tests: ["tests/dogfoodPhase1Acceptance.test.ts", "tests/realReportTestCounts.test.ts"]
  },
  // Memory evaluation, ingestion and verification scripts
  {
    match: (p) =>
      p.includes("scripts/eval-memory") ||
      p.includes("scripts/ingest-docs") ||
      p.includes("scripts/verify-phase-d") ||
      p.includes("eval/"),
    tests: ["tests/semanticMemory.test.ts"]
  },
  {
    match: (p) => p.includes("scripts/verify-phase-c"),
    tests: ["tests/userProfile.test.ts"]
  },
  {
    match: (p) => p.includes("scripts/verify-lan-copy"),
    tests: ["tests/clipboard.test.ts"]
  },
  // Architecture diagrams
  {
    match: (p) => p.includes("docs/architecture.drawio"),
    tests: [
      "tests/architectureSvgPair.test.ts",
      "tests/dogfoodPhase1Acceptance.test.ts"
    ]
  },
  // Package manifests
  {
    match: (p) => p.endsWith("package.json") || p.endsWith("tsconfig.json"),
    tests: [
      "tests/agentEngine.test.ts",
      "tests/tasksApi.test.ts",
      "tests/supervisor.test.ts"
    ]
  }
];

/**
 * Files that are ignored by the zero-coverage check (non-code artifacts, documentation).
 */
function isIgnoredFile(normalizedPath: string): boolean {
  if (
    normalizedPath.startsWith(".git") ||
    normalizedPath.endsWith(".md") ||
    normalizedPath.endsWith(".txt") ||
    normalizedPath.endsWith(".png") ||
    normalizedPath.endsWith(".jpg") ||
    normalizedPath.endsWith(".jpeg") ||
    normalizedPath.endsWith(".ico") ||
    normalizedPath.endsWith(".gitignore") ||
    normalizedPath.endsWith(".dockerignore") ||
    normalizedPath.endsWith("package-lock.json") ||
    normalizedPath.includes("Dockerfile") ||
    normalizedPath.startsWith("docker-compose") ||
    normalizedPath.startsWith("deploy/") ||
    normalizedPath.startsWith("helm/") ||
    normalizedPath.startsWith(".github/") ||
    normalizedPath.includes(".tmp") ||
    normalizedPath.includes("temp-") ||
    normalizedPath.startsWith("scripts/lan-bridge") ||
    normalizedPath.startsWith("scripts/test-ui-render") ||
    normalizedPath.startsWith("scripts/capture-svg-render") ||
    normalizedPath.startsWith("scripts/verify-") ||
    normalizedPath.startsWith("docs/") ||
    normalizedPath.includes("/.user_uploaded/")
  ) {
    // Only exception: docs/architecture.drawio is covered
    if (normalizedPath.includes("architecture.drawio")) return false;
    return true;
  }
  return false;
}

/**
 * Maps an array of changed file paths to corresponding test suites.
 * Enforces zero-coverage-is-an-error: any non-ignored code file without tests is flagged.
 */
export function resolveAffectedTests(changedFiles: string[]): AffectedTestsResult {
  const testSet = new Set<string>();
  const uncovered: string[] = [];
  const ignored: string[] = [];

  for (const rawPath of changedFiles) {
    const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");

    // Ignore non-code files
    if (isIgnoredFile(normalized)) {
      ignored.push(rawPath);
      continue;
    }

    // Direct test file changed
    if (/tests\/[^/]+\.test\.ts$/.test(normalized)) {
      const testFile = normalized.startsWith("web-ui/")
        ? normalized.replace(/^web-ui\//, "")
        : normalized;
      testSet.add(testFile);
      continue;
    }

    // Check mapping rules
    let matched = false;
    for (const rule of MAPPING_RULES) {
      if (rule.match(normalized)) {
        matched = true;
        for (const t of rule.tests) {
          testSet.add(t);
        }
      }
    }

    if (!matched) {
      uncovered.push(rawPath);
    }
  }

  return {
    tests: Array.from(testSet),
    uncoveredFiles: uncovered,
    ignoredFiles: ignored
  };
}

/**
 * Inspects git to retrieve changed files (uncommitted + recent branch commits).
 */
export function getGitChangedFiles(repoRoot?: string, sinceRef?: string): string[] {
  const root = repoRoot || path.resolve(process.cwd(), fs.existsSync(path.join(process.cwd(), "web-ui")) ? "." : "..");
  const files = new Set<string>();

  try {
    // 1. Uncommitted working tree files (unstaged + staged)
    const statusOut = execSync("git status --porcelain", { cwd: root, encoding: "utf8" });
    for (const rawLine of statusOut.split("\n")) {
      if (!rawLine || rawLine.length < 3) continue;
      // In git status --porcelain: index 0 and 1 are status, index 2 is space, path is index 3+
      const filePath = rawLine.slice(3).trim().replace(/^"|"$/g, "");
      if (filePath) files.add(filePath);
    }

    // 2. If working tree has few/no files, inspect branch commits
    if (sinceRef) {
      const diffOut = execSync(`git diff --name-only ${sinceRef}`, { cwd: root, encoding: "utf8" });
      for (const line of diffOut.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    } else if (files.size === 0) {
      // Find merge-base with feat/v2-autonomous-platform or HEAD~1
      let baseSha = "";
      try {
        baseSha = execSync("git merge-base HEAD feat/v2-autonomous-platform", { cwd: root, encoding: "utf8" }).trim();
      } catch {
        try {
          baseSha = execSync("git merge-base HEAD origin/feat/v2-autonomous-platform", { cwd: root, encoding: "utf8" }).trim();
        } catch {
          baseSha = "HEAD~1";
        }
      }

      if (baseSha) {
        const diffOut = execSync(`git diff --name-only ${baseSha}..HEAD`, { cwd: root, encoding: "utf8" });
        for (const line of diffOut.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) files.add(trimmed);
        }
      }
    }
  } catch (err: any) {
    console.warn("[test:gate] Notice: error inspecting git diff:", err.message);
  }

  return Array.from(files);
}

/**
 * Parses authoritative TAP summary test counts (# pass <N>, # fail <N>).
 */
export function parseTapCounts(output: string): { passed: number; failed: number } {
  const passMatches = Array.from(output.matchAll(/# pass (\d+)/g));
  const failMatches = Array.from(output.matchAll(/# fail (\d+)/g));

  let passed = 0;
  let failed = 0;

  if (passMatches.length > 0) {
    for (const match of passMatches) {
      passed += parseInt(match[1], 10);
    }
  }
  if (failMatches.length > 0) {
    for (const match of failMatches) {
      failed += parseInt(match[1], 10);
    }
  }

  // Fallback if no TAP summary line found
  if (passMatches.length === 0 && failMatches.length === 0) {
    const okMatches = output.match(/^ok \d+ -/gm);
    const notOkMatches = output.match(/^not ok \d+ -/gm);
    passed = okMatches ? okMatches.length : 0;
    failed = notOkMatches ? notOkMatches.length : 0;
  }

  return { passed, failed };
}

/**
 * Runs the change-aware test gate.
 * Budgeted (<90s), zero-coverage-is-an-error.
 */
export function runTestGate(options: TestGateOptions = {}): TestGateOutcome {
  const budgetSeconds = options.budgetSeconds ?? 90;
  const startTime = Date.now();

  const changed = options.changedFiles ?? getGitChangedFiles(options.repoRoot, options.sinceRef);
  const resolved = resolveAffectedTests(changed);

  // Zero-coverage rejection
  if (resolved.uncoveredFiles.length > 0) {
    const errorMsg = `Zero test coverage detected for changed files: [${resolved.uncoveredFiles.join(", ")}]. Every change must be covered by a test suite.`;
    return {
      status: "failed",
      exitCode: 1,
      passed: 0,
      failed: resolved.uncoveredFiles.length,
      durationSeconds: 0,
      budgetSeconds,
      testsRan: [],
      changedFiles: changed,
      uncoveredFiles: resolved.uncoveredFiles,
      error: errorMsg
    };
  }

  // If dry run, return mapped tests immediately
  if (options.dryRun) {
    return {
      status: "passed",
      exitCode: 0,
      passed: 0,
      failed: 0,
      durationSeconds: 0,
      budgetSeconds,
      testsRan: resolved.tests,
      changedFiles: changed,
      uncoveredFiles: []
    };
  }

  const repoRoot = options.repoRoot || path.resolve(process.cwd(), fs.existsSync(path.join(process.cwd(), "web-ui")) ? "." : "..");
  const webUiCwd = fs.existsSync(path.join(process.cwd(), "tests"))
    ? process.cwd()
    : path.resolve(repoRoot, "web-ui");
  const mcpServerCwd = path.resolve(repoRoot, "mcp-server");
  const browserMcpCwd = path.resolve(repoRoot, "browser-mcp");

  const mcpIncluded = resolved.tests.includes("mcp-server:tests");
  const browserMcpIncluded = resolved.tests.includes("browser-mcp:tests");
  const webUiTestsToRun = resolved.tests.filter(
    (t) => t !== "mcp-server:tests" && t !== "browser-mcp:tests"
  );

  if (webUiTestsToRun.length === 0 && !mcpIncluded && !browserMcpIncluded) {
    webUiTestsToRun.push("tests/toolParser.test.ts");
  }

  const allTestsRan = [...webUiTestsToRun];
  if (mcpIncluded) allTestsRan.push("mcp-server");
  if (browserMcpIncluded) allTestsRan.push("browser-mcp");

  let testOutput = "";
  let passedCount = 0;
  let failedCount = 0;
  let runError: string | undefined;

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  // 1. Run web-ui tests if any mapped
  if (webUiTestsToRun.length > 0) {
    try {
      const remainingTime = Math.max(1, budgetSeconds * 1000 - (Date.now() - startTime));
      const cmd = `npx tsx --test ${webUiTestsToRun.join(" ")}`;
      const out = execSync(cmd, {
        cwd: webUiCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        timeout: remainingTime
      });
      testOutput += out;
      const counts = parseTapCounts(out);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
        runError = "web-ui test runner produced unparseable TAP output";
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed;
      }
    } catch (err: any) {
      const stdout = err.stdout ? err.stdout.toString() : "";
      const stderr = err.stderr ? err.stderr.toString() : "";
      testOutput += `${stdout}\n${stderr}`;
      const counts = parseTapCounts(testOutput);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed > 0 ? counts.failed : 1;
      }
      runError = err.message;
    }
  }

  // 2. Run mcp-server tests if mcp-server was touched
  if (mcpIncluded && fs.existsSync(mcpServerCwd) && !runError) {
    try {
      const remainingTime = Math.max(1, budgetSeconds * 1000 - (Date.now() - startTime));
      const mcpOut = execSync("npm test", {
        cwd: mcpServerCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        timeout: remainingTime
      });
      testOutput += `\n--- MCP Server Test Suite ---\n${mcpOut}`;
      const counts = parseTapCounts(mcpOut);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
        runError = "mcp-server test runner produced unparseable TAP output";
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed;
      }
    } catch (err: any) {
      const stdout = err.stdout ? err.stdout.toString() : "";
      const stderr = err.stderr ? err.stderr.toString() : "";
      testOutput += `\n--- MCP Server Failure ---\n${stdout}\n${stderr}`;
      const counts = parseTapCounts(stdout + "\n" + stderr);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed > 0 ? counts.failed : 1;
      }
      runError = err.message;
    }
  }

  // 3. Run browser-mcp tests if browser-mcp was touched
  if (browserMcpIncluded && fs.existsSync(browserMcpCwd) && !runError) {
    try {
      const remainingTime = Math.max(1, budgetSeconds * 1000 - (Date.now() - startTime));
      const browserOut = execSync("npm test", {
        cwd: browserMcpCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        timeout: remainingTime
      });
      testOutput += `\n--- Browser MCP Test Suite ---\n${browserOut}`;
      const counts = parseTapCounts(browserOut);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
        runError = "browser-mcp test runner produced unparseable TAP output";
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed;
      }
    } catch (err: any) {
      const stdout = err.stdout ? err.stdout.toString() : "";
      const stderr = err.stderr ? err.stderr.toString() : "";
      testOutput += `\n--- Browser MCP Failure ---\n${stdout}\n${stderr}`;
      const counts = parseTapCounts(stdout + "\n" + stderr);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed > 0 ? counts.failed : 1;
      }
      runError = err.message;
    }
  }

  const rawDurationSeconds = (Date.now() - startTime) / 1000;
  const durationSeconds = parseFloat(rawDurationSeconds.toFixed(3));

  // Check budget overrun or execution timeout
  const timedOut = rawDurationSeconds > budgetSeconds ||
    (runError && (runError.includes("ETIMEDOUT") || runError.includes("timed out")));

  if (timedOut) {
    return {
      status: "failed",
      exitCode: 1,
      passed: passedCount,
      failed: failedCount || 1,
      durationSeconds,
      budgetSeconds,
      testsRan: allTestsRan,
      changedFiles: changed,
      uncoveredFiles: [],
      error: `Test execution exceeded budget of ${budgetSeconds}s (took ${durationSeconds}s)`,
      output: testOutput
    };
  }

  const status = failedCount === 0 && !runError ? "passed" : "failed";
  const exitCode = status === "passed" ? 0 : 1;

  return {
    status,
    exitCode,
    passed: passedCount,
    failed: failedCount,
    durationSeconds,
    budgetSeconds,
    testsRan: allTestsRan,
    changedFiles: changed,
    uncoveredFiles: [],
    error: runError,
    output: testOutput
  };
}
