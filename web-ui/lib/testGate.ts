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
    match: (p) => /tests\/[^/]+\.test\.(ts|js)$/.test(p),
    tests: [] // handled dynamically
  },
  // Test helpers (e.g. tests/helpers/serviceMocks.ts)
  {
    match: (p) => p.includes("tests/helpers/"),
    tests: ["tests/workerPool.test.ts", "tests/deliverableContracts.test.ts"]
  },
  // Grounding helpers (search query derivation, honest-abort gate)
  {
    match: (p) => p.includes("lib/grounding"),
    tests: ["tests/groundingGate.test.ts"]
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
      "tests/architectureSvgPair.test.ts",
      "tests/artifactDeliveryAndPolish.test.ts"
    ]
  },
  // ChatStream, ThinkingPanel, chatUtils, contextBudget, and chat history components
  {
    match: (p) => p.includes("components/ChatStream") || p.includes("components/ThinkingPanel") || p.includes("lib/chatUtils") || p.includes("lib/contextBudget"),
    tests: [
      "tests/chatReasoningAndProgress.test.ts",
      "tests/chatDispatch.test.ts",
      "tests/chatStreaming.test.ts",
      "tests/svgComponent.test.ts",
      "tests/chatHistory.test.ts",
      "tests/frontendRefreshRehydration.test.ts",
      "tests/unifiedUi.test.ts",
      "tests/chatPolish.test.ts",
      "tests/sprint2UiNavigationAndScroll.test.ts",
      "tests/chatContextBudget.test.ts",
      "tests/chatActionDiscipline.test.ts",
      "tests/chatScrollFollow.test.ts",
      "tests/agentGroundingAndHeadroom.test.ts",
      "tests/mobileUiPolish.test.ts",
      "tests/artifactDeliveryAndPolish.test.ts"
    ]
  },
  // Unified Agent UI (Material 3) components, threads store & API
  {
    match: (p) =>
      p.includes("lib/threads") ||
      p.includes("lib/hooks") ||
      p.includes("app/api/threads") ||
      p.includes("components/LiveRunBlock") ||
      p.includes("components/ArtifactRenderers") ||
      p.includes("components/ModelBottomSheet") ||
      p.includes("components/ModelSelector") ||
      p.includes("components/ThreadsSidebar") ||
      p.includes("components/NavigationDrawer") ||
      p.includes("components/SettingsView") ||
      p.includes("components/BuildsView") ||
      p.includes("components/SkillsView") ||
      p.includes("tailwind.config") ||
      p.includes("next.config") ||
      p.includes("app/layout.tsx") ||
      p.includes("app/globals.css") ||
      p.includes("app/design-tokens.css"),
    tests: [
      "tests/chatReasoningAndProgress.test.ts",
      "tests/threadsLaunchTask.test.ts",
      "tests/unifiedUi.test.ts",
      "tests/sessionIntegrity.test.ts",
      "tests/chatPolish.test.ts",
      "tests/taskControls.test.ts",
      "tests/sprint2UiNavigationAndScroll.test.ts",
      "tests/skillsProposeApprove.test.ts",
      "tests/mobileHeaderNav.test.ts",
      "tests/engineToggle.test.ts"
    ]
  },
  {
    match: (p) => p.includes("lib/chatHistory"),
    tests: ["tests/chatHistory.test.ts", "tests/frontendRefreshRehydration.test.ts"]
  },
  // Projects & Folders (Phases 1-4)
  {
    match: (p) =>
      p.includes("lib/projects/") ||
      p.includes("app/api/projects") ||
      p.includes("components/ProjectsView"),
    tests: [
      "tests/projectsRegistryAndExplorer.test.ts",
      "tests/projectOvernightRunner.test.ts"
    ]
  },
  // Memory profile & durable facts
  {
    match: (p) => p.includes("lib/memory"),
    tests: ["tests/userProfile.test.ts"]
  },
  // Skill gate
  {
    match: (p) => p.includes("lib/subagents/skillGate"),
    tests: ["tests/skillGate.test.ts"]
  },
  // Chat API route and progressive tools
  {
    match: (p) => p.includes("app/api/chat/route") || p.includes("lib/progressiveTools") || p.includes("lib/conversationCompaction"),
    tests: [
      "tests/chatStreaming.test.ts",
      "tests/toolParser.test.ts",
      "tests/fileParser.test.ts",
      "tests/ingestionPipeline.test.ts",
      "tests/userProfile.test.ts",
      "tests/chatActionDiscipline.test.ts",
      "tests/agentGroundingAndHeadroom.test.ts",
      "tests/progressiveToolDisclosure.test.ts",
      "tests/conversationCompaction.test.ts",
      "tests/llmProvider.test.ts"
    ]
  },
  // LLM Provider abstraction, standalone supervisor & engine control
  {
    match: (p) =>
      p.includes("lib/llm/") ||
      p.includes("lib/agentEngine") ||
      p.includes("scripts/llamacpp-standalone") ||
      p.includes("app/api/engine") ||
      p.includes("components/EngineStatusPill") ||
      p.includes("app/api/sandbox-status/route"),
    tests: [
      "tests/llmProvider.test.ts",
      "tests/engineRoute.test.ts",
      "tests/engineToggle.test.ts"
    ]
  },
  // Tasks API route
  {
    match: (p) => p.includes("app/api/tasks/route"),
    tests: ["tests/tasksApi.test.ts", "tests/activeTaskRehydration.test.ts", "tests/taskControls.test.ts"]
  },
  // Files API route & Workspace File alias
  {
    match: (p) => p.includes("app/api/files/route") || p.includes("app/api/workspace/file"),
    tests: ["tests/svgRendering.test.ts", "tests/punchlistBackendFixes.test.ts"]
  },
  // Patch Core surgical utility
  {
    match: (p) => p.includes("lib/subagents/patchCore"),
    tests: ["tests/punchlistBackendFixes.test.ts"]
  },
  // Subagents & Supervisor
  {
    match: (p) => p.includes("lib/subagents/supervisor"),
    tests: [
      "tests/supervisor.test.ts",
      "tests/canonicalLifecycle.test.ts",
      "tests/taskCompletion.test.ts",
      "tests/browserMcpConnectivity.test.ts",
      "tests/activeTaskRehydration.test.ts",
      "tests/taskControls.test.ts"
    ]
  },
  {
    match: (p) => p.includes("lib/subagents/workerPool"),
    tests: ["tests/workerPool.test.ts", "tests/critic.test.ts", "tests/workerHonesty.test.ts", "tests/langgraphSupervisorNodes.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/llmClient"),
    tests: ["tests/workerHonesty.test.ts", "tests/workerPool.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/residency"),
    tests: ["tests/workerHonesty.test.ts", "tests/vramResidencyAndMultiFile.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/planner"),
    tests: ["tests/planner.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/morningReport"),
    tests: ["tests/morningReport.test.ts", "tests/realReportTestCounts.test.ts"]
  },
  {
    match: (p) => p.includes("lib/subagents/types") || p.includes("lib/subagents/scheduler"),
    tests: [
      "tests/supervisor.test.ts",
      "tests/workerPool.test.ts",
      "tests/scheduler.test.ts",
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
    match: (p) => p.includes("config/models") || p.includes("deploy/modelfiles") || p.includes("Modelfile"),
    tests: ["tests/models.test.ts", "tests/modelfiles.test.ts"]
  },
  // Makefile deployment configuration
  {
    match: (p) => p === "Makefile" || p.endsWith("/Makefile"),
    tests: ["tests/deploymentConfig.test.ts"]
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
  // Architecture diagram generator & dogfood toolchain
  {
    match: (p) =>
      p.includes("lib/diagram/architectureGenerator") ||
      p.includes("scripts/drawio-to-svg") ||
      p.includes("architecture.drawio") ||
      p.includes("architecture.svg"),
    tests: [
      "tests/architectureSvgPair.test.ts",
      "tests/dogfoodPhase1Acceptance.test.ts",
      "tests/dogfoodToolchain.test.ts"
    ]
  },
  // UI views and components
  {
    match: (p) =>
      p.includes("components/MorningReportView") ||
      p.includes("app/morning-report") ||
      p.includes("app/api/morning-report"),
    tests: ["tests/morningReport.test.ts", "tests/realReportTestCounts.test.ts"]
  },
  // Run Ledger & Run Controls (Sprint 12 Phase 4)
  {
    match: (p) => p.includes("lib/ledger/"),
    tests: [
      "tests/ledger.test.ts",
      "tests/ledgerStats.test.ts",
      "tests/pause_resume.test.ts",
      "tests/restart.test.ts",
      "tests/crash_recovery.test.ts"
    ]
  },
  // Deploy API (Sprint 7)
  {
    match: (p) => p.includes("app/api/deploy") || p.includes("components/LiveRunBlock"),
    tests: ["tests/deployApiWiring.test.ts"]
  },
  // Build Deploy Flow (Sprint 12 Phase 5)
  {
    match: (p) => p.includes("lib/deploy/"),
    tests: ["tests/deployFlow.test.ts"]
  },
  // Human Skill Gates (Sprint 3)
  {
    match: (p) => p.includes("app/api/skills") || p.includes("components/SkillsView") || p.includes("lib/subagents/skillGate"),
    tests: ["tests/humanSkillGates.test.ts", "tests/skillsProposeApprove.test.ts"]
  },
  // Flywheel Skills Spike (Sprint 12 Phase 7)
  {
    match: (p) => p.includes("lib/flywheel/"),
    tests: ["tests/flywheelSkills.test.ts"]
  },
  // Worker Git Operations (Sprint 12 Phase 8)
  {
    match: (p) => p.includes("lib/git/"),
    tests: ["tests/workerGitOps.test.ts"]
  },
  // Worker CI Feedback (Sprint 12 Phase 9)
  {
    match: (p) => p.includes("lib/ci/"),
    tests: ["tests/workerCiFeedback.test.ts"]
  },
  // Self-Deploy Pipeline (Sprint 12 Phase 10)
  {
    match: (p) => p.includes("lib/deploy/selfDeploy"),
    tests: ["tests/selfDeploy.test.ts"]
  },
  {
    match: (p) => p.includes("components/ChatStream"),
    tests: ["tests/chatStreaming.test.ts", "tests/chatReasoningAndProgress.test.ts"]
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
      "tests/chatStreaming.test.ts",
      "tests/artifactDeliveryAndPolish.test.ts"
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
    tests: ["tests/skillGate.test.ts"]
  },
  {
    match: (p) => p.includes("scripts/verify-phase-c"),
    tests: ["tests/userProfile.test.ts"]
  },
  {
    match: (p) => p.includes("scripts/verify-lan-copy"),
    tests: ["tests/clipboard.test.ts"]
  },
  // Verification & capture scripts timeout guard (Phase 0.5)
  {
    match: (p) =>
      p.includes("scripts/capture-svg-render") ||
      p.includes("scripts/test-ui-render") ||
      p.includes("scripts/run-full-suite") ||
      p.includes("scripts/test-honest-abort-live") ||
      p.includes("scripts/test-model-formulation-live") ||
      p.includes("scripts/verify-"),
    tests: ["tests/e2eScriptTimeouts.test.ts"]
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
      "tests/tasksApi.test.ts",
      "tests/supervisor.test.ts"
    ]
  },
  // Repository hygiene & documentation integrity (Sprint 4 & 5)
  {
    match: (p) => p === "LICENSE" || p.includes(".opencode-remote-session") || p.includes("triage-report") || p.includes("BRANCH_TRIAGE"),
    tests: ["tests/repoHygiene.test.ts", "tests/docsIntegrity.test.ts"]
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
    normalizedPath.includes(".agent") ||
    normalizedPath.includes("temp-") ||
    normalizedPath.endsWith("full-suite-results.json") ||
    normalizedPath.startsWith("scripts/lan-bridge") ||
    normalizedPath.startsWith("scripts/dev-proxy") ||
    normalizedPath.startsWith("scripts/bench-") ||
    normalizedPath.startsWith("scripts/test-q3") ||
    normalizedPath.startsWith("docs/") ||
    normalizedPath.includes("/.user_uploaded/") ||
    normalizedPath.endsWith("script.py") ||
    normalizedPath.endsWith(".py")
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
    if (/tests\/[^/]+\.test\.(ts|js)$/.test(normalized)) {
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
    const statusOut = execSync("git status --porcelain -uall", { cwd: root, encoding: "utf8" });
    for (const rawLine of statusOut.split("\n")) {
      if (!rawLine || rawLine.length < 3) continue;
      // In git status --porcelain: index 0 and 1 are status, index 2 is space, path is index 3+
      let filePath = rawLine.slice(3).trim().replace(/^"|"$/g, "");
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1].trim().replace(/^"|"$/g, "");
      }
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
      // Find merge-base with origin/develop, origin/main, or HEAD~1
      let baseSha = "";
      try {
        baseSha = execSync("git merge-base HEAD origin/develop", { cwd: root, encoding: "utf8" }).trim();
      } catch {
        try {
          baseSha = execSync("git merge-base HEAD origin/main", { cwd: root, encoding: "utf8" }).trim();
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
  // TAP format: "# pass 12", tsx/node:test format: "ℹ pass 12"
  const passMatches = Array.from(output.matchAll(/(?:#|ℹ) pass (\d+)/g));
  const failMatches = Array.from(output.matchAll(/(?:#|ℹ) fail (\d+)/g));

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
  if (!childEnv.FORCE_MOCK) childEnv.FORCE_MOCK = "1";
  if (!childEnv.FAST_GRAPH_TEST) childEnv.FAST_GRAPH_TEST = "1";

  // 1. Run web-ui tests if any mapped
  if (webUiTestsToRun.length > 0) {
    try {
      const remainingTime = Math.max(1, budgetSeconds * 1000 - (Date.now() - startTime));
      const cmd = `npx tsx --tsconfig tsconfig.json --test ${webUiTestsToRun.join(" ")}`;
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
