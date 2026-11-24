import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const GATE_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ANCHORED_WEB_UI_ROOT = path.resolve(GATE_MODULE_DIR, "..");
const ANCHORED_REPO_ROOT = path.resolve(ANCHORED_WEB_UI_ROOT, "..");
const TSX_TEST_BATCH_SIZE = 120;

function resolveTsxCliPath(webUiCwd: string, repoRoot: string): string | null {
  const candidates = [
    path.join(webUiCwd, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Canonical workspaces that define "the suite" across the entire repository.
 * Every workspace in root package.json is included: web-ui, mcp-server, browser-mcp.
 */
export const CANONICAL_WORKSPACES = ["web-ui", "mcp-server", "browser-mcp"] as const;
export type CanonicalWorkspace = (typeof CANONICAL_WORKSPACES)[number];

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
  stages?: string[];
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
  {
    match: (p) =>
      p.includes("lib/microElision") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/chat/turnEngine") ||
      p.includes("lib/contextBudget") ||
      p.includes("lib/llm/provider") ||
      p.includes("prefixReusePreservation.test.ts"),
    tests: ["tests/prefixReusePreservation.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/contextBudget") ||
      p.includes("lib/conversationCompaction") ||
      p.includes("lib/microElision") ||
      p.includes("lib/modelLimits") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/llm/provider") ||
      p.includes("contextEconomics.test.ts"),
    tests: ["tests/contextEconomics.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/contextBudget") ||
      p.includes("lib/conversationCompaction") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/llm/provider") ||
      p.includes("estimateScanPerRound.test.ts"),
    tests: ["tests/estimateScanPerRound.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/chat/turnEngine") ||
      p.includes("app/api/chat/route") ||
      p.includes("lib/llm/provider") ||
      p.includes("countingTruth.test.ts"),
    tests: ["tests/countingTruth.test.ts"],
  },
  {
    match: (p) =>
      p.includes("repoStandards.test.ts") ||
      p.includes("SECURITY.md") ||
      p.includes("CONTRIBUTING.md") ||
      p.includes(".nvmrc") ||
      p.includes(".gitattributes") ||
      p.includes(".github/dependabot.yml") ||
      p.includes(".github/PULL_REQUEST_TEMPLATE.md") ||
      p.includes(".github/ISSUE_TEMPLATE/"),
    tests: ["tests/repoStandards.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/subagents/supervisor") ||
      p.includes("lib/subagents/stepExecutor") ||
      p.includes("lib/git/workerGitOps") ||
      p.includes("app/api/tasks/route") ||
      p.includes("activeTaskRehydration.test.ts") ||
      p.includes("tasksApi.test.ts") ||
      p.includes("testGitIsolationGuard.test.ts"),
    tests: ["tests/testGitIsolationGuard.test.ts"],
  },
  {
    match: (p) =>
      p.includes("observedTurnLiveness.test.ts") ||
      p.includes("lib/liveActivity") ||
      p.includes("lib/turnSpeed") ||
      p.includes("components/NowLineBar") ||
      p.includes("components/ChatStream") ||
      p.includes("components/NavigationDrawer") ||
      p.includes("components/ThreadsSidebar") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/threads/types") ||
      p.includes("app/page"),
    tests: ["tests/observedTurnLiveness.test.ts"],
  },
  {
    match: (p) =>
      p.includes("roundNarrationAssembly.test.ts") ||
      p.includes("lib/liveActivity") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/chat/turnEngine") ||
      p.includes("lib/streamSnapshot") ||
      p.includes("lib/activityTimeline") ||
      p.includes("components/ActivityTimeline") ||
      p.includes("components/chat/messageRender"),
    tests: ["tests/roundNarrationAssembly.test.ts"],
  },
  {
    match: (p) =>
      p.includes("coalescedFileDiffPipeline.test.ts") ||
      p.includes("lib/activityTimeline") ||
      p.includes("lib/chatDiffs") ||
      p.includes("lib/chatUtils") ||
      p.includes("lib/stintDerivation") ||
      p.includes("components/ActivityTimeline") ||
      p.includes("components/CanvasDiffSheet") ||
      p.includes("components/LiveActivityHeader") ||
      p.includes("components/chat/messageRender") ||
      p.includes("components/ChatStream") ||
      p.includes("app/api/files/route"),
    tests: ["tests/coalescedFileDiffPipeline.test.ts", "tests/uirHeaderActivity.test.ts"],
  },
  {
    match: (p) => p.includes("lib/activityTimeline") || p.includes("activityTimeline.test.ts"),
    tests: ["tests/activityTimeline.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/ActivityTimeline") || p.includes("activityTimelineRender.test.ts"),
    tests: ["tests/activityTimelineRender.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/turnSpeed") ||
      p.includes("components/NowLineBar") ||
      p.includes("turnSpeed.test.ts"),
    tests: ["tests/turnSpeed.test.ts"],
  },
  {
    match: (p) => p.includes("lib/autoFollow") || p.includes("autoFollow.test.ts"),
    tests: ["tests/autoFollow.test.ts"],
  },
  {
    match: (p) => p.includes("components/CanvasDiffSheet") || p.includes("canvasDiffSheet.test.ts"),
    tests: ["tests/canvasDiffSheet.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/stintDerivation") ||
      p.includes("components/StintCard") ||
      p.includes("stintDerivation.test.ts"),
    tests: ["tests/stintDerivation.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/repoMap") || p.includes("repoMap.test.ts"),
    tests: ["tests/repoMap.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/subagents/codeValidation") || p.includes("codeValidation.test.ts"),
    tests: ["tests/codeValidation.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/testBaseline") || p.includes("testBaseline.test.ts"),
    tests: ["tests/testBaseline.test.ts", "tests/blockingGateRevert.test.ts"],
  },
  {
    match: (p) =>
      p.includes("threadStore.ts") ||
      p.includes("app/api/threads/route.ts") ||
      p.includes("ChatStream.tsx") ||
      p.includes("threadClearMessages.test.ts"),
    tests: ["tests/threadClearMessages.test.ts"],
  },
  {
    match: (p) => p.includes("LiveRunBlock.tsx") || p.includes("liveRunBlockStatus.test.ts"),
    tests: ["tests/liveRunBlockStatus.test.ts"],
  },
  {
    match: (p) => p.includes("LiveRunBlock.tsx") || p.includes("liveRunBlockPreview.test.ts"),
    tests: ["tests/liveRunBlockPreview.test.ts"],
  },
  {
    match: (p) =>
      p.includes("ciSpeed.test.ts") ||
      p.includes(".github/workflows/ci.yml") ||
      p.includes(".github/workflows/chaos.yml"),
    tests: ["tests/ciSpeed.test.ts"],
  },
  {
    match: (p) => p.includes("explorerFs.test.ts") || p.includes("explorerFs.ts"),
    tests: ["tests/explorerFs.test.ts"],
  },
  {
    match: (p) => p.includes("explorerPanel.spec.ts") || p.includes("ExplorerPanel.tsx"),
    tests: ["tests/e2e/explorerPanel.spec.ts"],
  },
  {
    match: (p) =>
      p.includes("inTurnExperience.spec.ts") ||
      p.includes("ChatStream.tsx") ||
      p.includes("LiveRunBlock.tsx") ||
      p.includes("ThinkingPanel.tsx"),
    tests: ["tests/e2e/inTurnExperience.spec.ts"],
  },
  {
    match: (p) =>
      p.includes("invariantNetB4.spec.ts") ||
      p.includes("BoardView.tsx") ||
      p.includes("ChatStream.tsx"),
    tests: ["tests/e2e/invariantNetB4.spec.ts"],
  },
  {
    match: (p) => p.includes("invariantNetB3.spec.ts") || p.includes("ChatStream.tsx"),
    tests: ["tests/e2e/invariantNetB3.spec.ts"],
  },
  {
    match: (p) => p.includes("invariantNetB2.spec.ts") || p.includes("ChatStream.tsx"),
    tests: ["tests/e2e/invariantNetB2.spec.ts"],
  },
  {
    match: (p) =>
      p.includes("invariantNetB1.spec.ts") ||
      p.includes("ChatStream.tsx") ||
      p.includes("BoardView.tsx"),
    tests: ["tests/e2e/invariantNetB1.spec.ts"],
  },
  {
    match: (p) =>
      p.includes("invariantNetA4.test.ts") ||
      p.includes("NavigationDrawer.tsx") ||
      p.includes("SettingsView.tsx") ||
      p.includes("BoardView.tsx"),
    tests: ["tests/invariantNetA4.test.ts"],
  },
  {
    match: (p) => p.includes("invariantNetA3.test.ts") || p.includes("toolCallIntegrity.ts"),
    tests: ["tests/invariantNetA3.test.ts"],
  },
  {
    match: (p) =>
      p.includes("invariantNetA2.test.ts") ||
      p.includes("ChatStream.tsx") ||
      p.includes("NavigationDrawer.tsx"),
    tests: ["tests/invariantNetA2.test.ts"],
  },
  {
    match: (p) =>
      p.includes("invariantNetA1.spec.ts") ||
      p.includes("ChatStream.tsx") ||
      p.includes("BoardView.tsx") ||
      p.includes("NavigationDrawer.tsx"),
    tests: ["tests/e2e/invariantNetA1.spec.ts"],
  },
  {
    match: (p) =>
      p.includes("uiuxCheckthroughFixes2.test.ts") ||
      p.includes("ChatStream.tsx") ||
      p.includes("BoardView.tsx") ||
      p.includes("NavigationDrawer.tsx"),
    tests: ["tests/uiuxCheckthroughFixes2.test.ts"],
  },
  {
    match: (p) =>
      p.includes("uiuxAuditFixes.test.ts") ||
      p.includes("BoardView.tsx") ||
      p.includes("SandboxGauge.tsx") ||
      p.includes("boardSeed.ts") ||
      p.includes("boardStore.ts"),
    tests: ["tests/uiuxAuditFixes.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/streamTail") ||
      p.includes("lib/board/productionDrain") ||
      p.includes("lib/board/productionStageDeps") ||
      p.includes("boardStreamTail.test.ts"),
    tests: ["tests/boardStreamTail.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/productionDrain") || p.includes("boardDrainExecution.test.ts"),
    tests: ["tests/boardDrainExecution.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/boardOrchestrator") ||
      p.includes("lib/board/productionDrain") ||
      p.includes("lib/board/boardStore") ||
      p.includes("lib/threads/inAppSupervisor") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("boardDrainRecovery.test.ts"),
    tests: ["tests/boardDrainRecovery.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/reviewerGate") || p.includes("reviewerGate.test.ts"),
    tests: ["tests/reviewerGate.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/flowMonitor") || p.includes("flowMonitor.test.ts"),
    tests: ["tests/flowMonitor.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/dispatcher") || p.includes("dispatcher.test.ts"),
    tests: ["tests/dispatcher.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/mergeThreadsIntoBoard") || p.includes("boardGhostStatus.test.ts"),
    tests: ["tests/boardGhostStatus.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/agreementLedger") ||
      p.includes("app/api/board/reviewer-audit") ||
      p.includes("lib/board/boardOrchestrator") ||
      p.includes("lib/board/reviewerGate") ||
      p.includes("lib/deploy/selfDeployVerified") ||
      p.includes("orchestratorShadowStages.test.ts"),
    tests: ["tests/orchestratorShadowStages.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/productionStageDeps") ||
      p.includes("app/api/board/drain") ||
      p.includes("drainStageDeps.test.ts"),
    tests: ["tests/drainStageDeps.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/productionStageDeps") ||
      p.includes("lib/board/reviewerGate") ||
      p.includes("reviewerVerdictParser.test.ts"),
    tests: ["tests/reviewerVerdictParser.test.ts"],
  },
  {
    match: (p) =>
      p.includes("app/api/board/reviewer-audit") ||
      p.includes("lib/board/reviewerAuditEvaluate") ||
      p.includes("lib/board/productionStageDeps") ||
      p.includes("reviewerAuditEvaluate.test.ts"),
    tests: ["tests/reviewerAuditEvaluate.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/boardOrchestrator") ||
      p.includes("lib/board/boardControl.ts") ||
      p.includes("app/api/board/drain") ||
      p.includes("lib/subagents/morningReport") ||
      p.includes("boardOrchestrator.test.ts") ||
      p.includes("boardOrchestratorDrainReport.test.ts") ||
      p.includes("boardDrainExecution.test.ts"),
    tests: [
      "tests/boardOrchestrator.test.ts",
      "tests/boardOrchestratorDrainReport.test.ts",
      "tests/boardDrainExecution.test.ts",
    ],
  },
  {
    match: (p) =>
      p.includes("lib/board/boardControlStore") ||
      p.includes("app/api/board/control") ||
      p.includes("BoardView.tsx") ||
      p.includes("app/page.tsx") ||
      p.includes("boardControl.test.ts"),
    tests: ["tests/boardControl.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/monsterIntake") ||
      p.includes("app/api/board/intake") ||
      p.includes("BoardAddSheet.tsx") ||
      p.includes("monsterIntake.test.ts"),
    tests: ["tests/monsterIntake.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/board/") ||
      p.includes("app/api/board/") ||
      p.includes("BoardView.tsx") ||
      p.includes("BoardAddSheet.tsx") ||
      p.includes("boardStore.test.ts") ||
      p.includes("boardUi.test.ts"),
    tests: ["tests/boardStore.test.ts", "tests/boardUi.test.ts"],
  },
  {
    match: (f) => f.startsWith("eval/") || f.includes("evalPackGraders.test.ts"),
    tests: ["tests/evalPackGraders.test.ts"],
  },
  {
    match: (p) => p.includes("workerPool.ts") || p.includes("builderSurgicalLoop.test.ts"),
    tests: ["tests/builderSurgicalLoop.test.ts"],
  },
  {
    match: (p) => p.includes("BuildsView.tsx") || p.includes("buildsViewBoard.test.ts"),
    tests: ["tests/buildsViewBoard.test.ts"],
  },
  // Client-safe board thread-link helper (components import it; server stores re-export it)
  {
    match: (p) => p.includes("lib/board/threadLink"),
    tests: ["tests/buildsViewBoard.test.ts", "tests/boardStore.test.ts"],
  },
  {
    match: (p) => p.includes("dialectGuard") || p.includes("dialectGuardWiring.test.ts"),
    tests: ["tests/dialectGuardWiring.test.ts"],
  },
  {
    match: (p) => p.includes("ingestion") || p.includes("ingestionQdrantIds.test.ts"),
    tests: ["tests/ingestionQdrantIds.test.ts"],
  },
  {
    match: (p) => p.includes("supervisor.ts") || p.includes("p3FinishAndHandoffWiring.test.ts"),
    tests: ["tests/p3FinishAndHandoffWiring.test.ts"],
  },
  {
    match: (p) => p.includes("scheduler.ts") || p.includes("schedulerPlanner.test.ts"),
    tests: ["tests/schedulerPlanner.test.ts"],
  },
  {
    match: (p) => p.includes("security") || p.includes("securityHardeningWiring.test.ts"),
    tests: ["tests/securityHardeningWiring.test.ts"],
  },
  {
    match: (p) => p.includes("lib/jobChunking") || p.includes("jobChunkingHandoffs.test.ts"),
    tests: ["tests/jobChunkingHandoffs.test.ts"],
  },
  // job-queue-isolation: single-slot queue + per-job worktrees
  {
    match: (p) => p.includes("lib/jobQueue") || p.includes("lib/worktree"),
    tests: ["tests/jobQueueIsolation.test.ts", "tests/engineSlotReleaseDuringToolWait.test.ts"],
  },
  {
    // job-queue-isolation wiring: route serialization seam + route-level proof
    match: (p) => p.includes("lib/chatTurnGate") || p.includes("app/api/chat/route"),
    tests: ["tests/jobQueueRoute.test.ts", "tests/engineSlotReleaseDuringToolWait.test.ts"],
  },
  {
    // PrioritySlotScheduler single-slot arbiter & preemption wiring
    match: (p) =>
      p.includes("lib/slotScheduler") ||
      p.includes("lib/chatTurnGate") ||
      p.includes("app/api/chat/route") ||
      p.includes("app/api/threads/route") ||
      p.includes("app/api/threads/[id]/route") ||
      p.includes("lib/subagents/workerPool") ||
      p.includes("slotScheduler.test.ts") ||
      p.includes("slotUtilizationMetrics.test.ts"),
    tests: ["tests/slotScheduler.test.ts", "tests/slotUtilizationMetrics.test.ts"],
  },
  {
    match: (p) =>
      p.includes("app/api/threads/route") ||
      p.includes("lib/jobChunking") ||
      p.includes("threadsLaunchChunkBudget.test.ts"),
    tests: ["tests/threadsLaunchChunkBudget.test.ts"],
  },
  {
    match: (p) => p.includes("eval/run.mjs") || p.includes("evalRunnerJobMode.test.ts"),
    tests: ["tests/evalRunnerJobMode.test.ts"],
  },
  {
    match: (p) =>
      p.includes("eval/run.mjs") ||
      p.includes("eval/graders/tool-discipline.mjs") ||
      p.includes("evalRunnerEndpointDiscipline.test.ts"),
    tests: ["tests/evalRunnerEndpointDiscipline.test.ts"],
  },
  // Lane C UI polish (header, canvas & desktop top bar)
  {
    match: (p) =>
      p.includes("design-tokens.css") ||
      p.includes("globals.css") ||
      p.includes("ThreadsSidebar.tsx") ||
      p.includes("ChatStream.tsx") ||
      p.includes("ArtifactCanvas.tsx") ||
      p.includes("ArtifactRenderers.tsx") ||
      p.includes("SettingsView.tsx") ||
      p.includes("ProjectsView.tsx") ||
      p.includes("BuildsView.tsx") ||
      p.includes("NavigationDrawer.tsx") ||
      p.includes("DiffViewer.tsx") ||
      p.includes("ExecutionTrace.tsx") ||
      p.includes("MorningReportView.tsx") ||
      p.includes("darkTextFloor.test.ts") ||
      p.includes("overlayMutualExclusion.test.ts") ||
      p.includes("timestampFormat.test.ts") ||
      p.includes("chatUtils.ts") ||
      p.includes("telegramErrorDismiss.test.ts") ||
      p.includes("titleTruncationResiduals.test.ts") ||
      p.includes("SvgViewer.tsx") ||
      p.includes("threadSummariesCache.test.ts") ||
      p.includes("threadStore.ts") ||
      p.includes("hostRunnerDisconnectPresentation.test.ts") ||
      p.includes("narrationChunkSeparator.test.ts") ||
      p.includes("threadInitialSelection.test.ts"),
    tests: [
      "tests/darkTextFloor.test.ts",
      "tests/overlayMutualExclusion.test.ts",
      "tests/timestampFormat.test.ts",
      "tests/telegramErrorDismiss.test.ts",
      "tests/titleTruncationResiduals.test.ts",
      "tests/threadSummariesCache.test.ts",
      "tests/hostRunnerDisconnectPresentation.test.ts",
      "tests/narrationChunkSeparator.test.ts",
      "tests/threadInitialSelection.test.ts",
    ],
  },
  {
    // Board #59 + Timeline Iteration 2: single-emerald accent enforcement + dark/light contrast floors.
    match: (p) =>
      p.includes("accentContrastAudit.test.ts") ||
      p.includes("ActivityTimeline.tsx") ||
      p.includes("NowLineBar.tsx") ||
      p.includes("StintCard.tsx") ||
      p.includes("BoardView.tsx") ||
      p.includes("ChatStream.tsx") ||
      p.includes("SettingsView.tsx") ||
      p.includes("settings/DangerZone.tsx") ||
      p.includes("settings/EngineZone.tsx") ||
      p.includes("settings/NotificationsZone.tsx") ||
      p.includes("settings/MemoryZone.tsx"),
    tests: ["tests/accentContrastAudit.test.ts"],
  },
  {
    match: (p) =>
      p.includes("design-tokens.css") ||
      p.includes("globals.css") ||
      p.includes("ThreadsSidebar.tsx") ||
      p.includes("ChatStream.tsx") ||
      p.includes("ArtifactCanvas.tsx") ||
      p.includes("ArtifactRenderers.tsx") ||
      p.includes("SettingsView.tsx") ||
      p.includes("ProjectsView.tsx") ||
      p.includes("BuildsView.tsx") ||
      p.includes("SkillsView.tsx") ||
      p.includes("selfDeploy.ts") ||
      p.includes("ModelBottomSheet.tsx") ||
      p.includes("api/engine/route.ts") ||
      p.includes("SvgViewer.tsx") ||
      p.includes("app/icon.svg") ||
      p.includes("app/layout.tsx") ||
      p.includes("app/page.tsx"),
    tests: [
      "tests/lane-c-ui-polish.test.ts",
      "tests/canvas.test.ts",
      "tests/settingsView.test.ts",
      "tests/modelBottomSheet.test.ts",
      "tests/buildsView.test.ts",
      "tests/skillsView.test.ts",
      "tests/uiLayoutInvariants.test.ts",
    ],
  },
  // kind-gateway assets & launcher scripts
  {
    match: (p) => p.includes("kind-gateway") || p.includes("scripts/kind-gateway"),
    tests: ["tests/kindGateway.test.ts"],
  },
  // Dev-proxy & LAN-bridge watchdog
  {
    match: (p) => p.includes("scripts/dev-proxy") || p.includes("scripts/lan-bridge"),
    tests: ["tests/gatewayWatchdog.test.ts"],
  },
  // Direct test file changed: run itself
  {
    match: (p) => /tests\/[^/]+\.test\.(ts|js)$/.test(p),
    tests: [], // handled dynamically
  },
  // Notifications & Telegram outbound alerts
  {
    match: (p) => p.includes("notifications"),
    tests: ["tests/notifications.test.ts"],
  },
  // Host Mode & approvals & status & Host Bridge & Host Settings
  {
    match: (p) =>
      p.includes("hostMode") ||
      p.includes("hostSettings") ||
      p.includes("hostPathRestriction") ||
      p.includes("settings/host") ||
      p.includes("host/approvals") ||
      p.includes("host/status") ||
      p.includes("host-bridge") ||
      p.includes("hostDaemon") ||
      p.includes("build-host-runner") ||
      p.includes("aiLifecycle") ||
      p.includes("lifecycleTargetGuard") ||
      p.includes("hostFourState"),
    tests: [
      "tests/hostMode.test.ts",
      "tests/hostSettingsDefault.test.ts",
      "tests/hostFileRestriction.test.ts",
      "tests/chunkingSettings.test.ts",
      "tests/chunkingRouteGate.test.ts",
      "tests/chunkingSettingsUi.test.ts",
      "tests/hostFourState.test.ts",
      "tests/patchTools.test.ts",
      "tests/hostRunnerScript.test.ts",
      "tests/hostDaemon.test.ts",
      "tests/hostLifecycleUnit.test.ts",
      "tests/hostAsyncJobs.test.ts",
      "tests/lifecycleGuard.test.ts",
      "tests/chatFilePaging.test.ts",
      "tests/hostGitSafetyBattery.test.ts",
      "tests/unattendedGitOps.test.ts",
      "tests/unattendedGitToolAdmission.test.ts",
      "tests/approvalTokenBinding.test.ts",
    ],
  },
  // Approval token binding (Board #131): tokens bound to exact tool + payload
  {
    match: (p) => p.includes("approvalToken"),
    tests: ["tests/approvalTokenBinding.test.ts"],
  },
  // Progressive tool registry (patch tool registration)
  {
    match: (p) => p.includes("progressiveTools"),
    tests: ["tests/patchTools.test.ts"],
  },
  // Test helpers (e.g. tests/helpers/serviceMocks.ts)
  {
    match: (p) => p.includes("tests/helpers/"),
    tests: ["tests/workerPool.test.ts", "tests/deliverableContracts.test.ts"],
  },
  // Grounding helpers (search query derivation, honest-abort gate)
  {
    match: (p) => p.includes("lib/grounding"),
    tests: ["tests/groundingGate.test.ts"],
  },
  // Simulation mode engine, scenarios registry, and offline runner
  {
    match: (p) => p.includes("lib/simulator"),
    tests: ["tests/simulator.test.ts"],
  },
  // Clipboard utility
  {
    match: (p) => p.includes("lib/clipboard"),
    tests: ["tests/clipboard.test.ts"],
  },
  // Artifact download naming, MIME inference, and download helpers
  {
    match: (p) => p.includes("lib/artifactDownload") || p.includes("lib/attachmentMime"),
    tests: ["tests/artifactDownload.test.ts", "tests/svgComponent.test.ts"],
  },
  // SVG utilities and SVG viewer component
  {
    match: (p) => p.includes("lib/svgUtils") || p.includes("components/SvgViewer"),
    tests: [
      "tests/svgRendering.test.ts",
      "tests/svgComponent.test.ts",
      "tests/architectureSvgPair.test.ts",
      "tests/artifactDeliveryAndPolish.test.ts",
    ],
  },
  {
    match: (p) => p.includes("app/api/board/route"),
    tests: ["tests/p5BoardAndPipeline.test.ts"],
  },

  {
    match: (p) => p.includes("lib/prePrPipeline"),
    tests: ["tests/p5BoardAndPipeline.test.ts"],
  },
  {
    match: (p) => p.includes("lib/securityHardening") || p.includes("lib/selfDeployMachinery"),
    tests: ["tests/p6SecurityDeployEvalIngestion.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/finishVerificationGate"),
    tests: ["tests/p32AndP33SupervisorGates.test.ts"],
  },
  // ChatStream, ThinkingPanel, chatUtils, contextBudget, and chat history components
  {
    match: (p) =>
      p.includes("components/ChatStream") ||
      p.includes("components/ThinkingPanel") ||
      p.includes("lib/chatUtils") ||
      p.includes("lib/chatDiffs") ||
      p.includes("lib/contextBudget") ||
      p.includes("lib/chatStatus") ||
      p.includes("lib/modelLimits") ||
      p.includes("lib/conversationCompaction"),
    tests: [
      "tests/thinkingPanel.test.ts",
      "tests/stopTurnFidelity.test.ts",
      "tests/chatReasoningAndProgress.test.ts",
      "tests/chatDispatch.test.ts",
      "tests/chatStreaming.test.ts",
      "tests/svgComponent.test.ts",
      "tests/chatHistory.test.ts",
      "tests/frontendRefreshRehydration.test.ts",
      "tests/unifiedUi.test.ts",
      "tests/chatPolish.test.ts",
      "tests/chatDiffCollapseCanvasSwitch.test.ts",
      "tests/sprint2UiNavigationAndScroll.test.ts",
      "tests/chatContextBudget.test.ts",
      "tests/chatActionDiscipline.test.ts",
      "tests/chatScrollFollow.test.ts",
      "tests/agentGroundingAndHeadroom.test.ts",
      "tests/mobileUiPolish.test.ts",
      "tests/artifactDeliveryAndPolish.test.ts",
      "tests/chatUiHonestyAndCopy.test.ts",
      "tests/chatFilePaging.test.ts",
      "tests/chatTurnHonesty.test.ts",
      "tests/chatTextTruth.test.ts",
      "tests/incompleteStatusAffordance.test.ts",
      "tests/chatStreamTokenPreservation.test.ts",
      "tests/fix5NarrationAndProse.test.ts",
      "tests/p21ToolCallIntegrity.test.ts",
      "tests/p22PatchAndDialect.test.ts",
      "tests/p32AndP33SupervisorGates.test.ts",

      "tests/p5BoardAndPipeline.test.ts",
      "tests/p6SecurityDeployEvalIngestion.test.ts",
      "tests/chatSteerSubmitUx.test.ts",
      "tests/capDefault.test.ts",
      "tests/chatRoundBudget.test.ts",
      "tests/chatWebResearchCap.test.ts",
      "tests/uirHeaderActivity.test.ts",
    ],
  },
  // uir-0/uir-1: live-activity helpers, header diet
  {
    match: (p) => p.includes("lib/liveActivity"),
    tests: [
      "tests/uirHeaderActivity.test.ts",
      "tests/chatLiveVisibility.test.ts",
      "tests/chatPolish.test.ts",
    ],
  },
  // Threads store & Threads API
  {
    match: (p) => p.includes("lib/threads") || p.includes("app/api/threads"),
    tests: [
      "tests/threadsLaunchTask.test.ts",
      "tests/sessionIntegrity.test.ts",
      "tests/chatReasoningAndProgress.test.ts",
      "tests/permissions.test.ts",
      "tests/chatPersistenceDecoupling.test.ts",
      "tests/chatLiveVisibility.test.ts",
      "tests/threadDelete.test.ts",
      "tests/threadDeleteUi.test.ts",
      "tests/threadCompaction.test.ts",
      "tests/threadsResumeRestartExecution.test.ts",
      "tests/chatTurnPresence.test.ts",
      "tests/chatThinkingPreservation.test.ts",
      "tests/thread-list-summaries.test.ts",
      "tests/threadStoreCheapSweep.test.ts",
      "tests/thread-list-loading-and-selection.test.ts",
      "tests/thread-search-snippet.test.ts",
      "tests/live-meter-done-parity.test.ts",
      "tests/buildLaunchVisibility.test.ts",
      "tests/supervisorGitOpsIntegration.test.ts",
      // UI-008: readable thread-list titles derived at record-create time
      "tests/threadTitles.test.ts",
      "tests/threadLiveness.test.ts",
      "tests/threadTitleDerivation.test.ts",
    ],
  },
  // Turn liveness: stall window, heartbeat, forced round-boundary snapshot, sidebar badges
  {
    match: (p) =>
      p.includes("app/api/chat/route") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/threads/streamSnapshot") ||
      p.includes("components/ThreadsSidebar"),
    tests: ["tests/turnLiveness.test.ts", "tests/roundDeadlines.test.ts"],
  },
  // qa-6 / UI-001 + UI-002: zombie streaming cap — leaked presence /
  // execution live signals older than the hard cap with a stale record are
  // reaped by reconcile instead of keeping a dead turn live forever
  {
    match: (p) => p.includes("lib/threads/threadStore"),
    tests: ["tests/zombieStreamingCap.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/commandDialectGuard") ||
      p.includes("lib/commandDialectTraps") ||
      p.includes("lib/hostMode"),
    tests: ["tests/commandDialectGuard.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/finishVerification") || p.includes("components/CompletionVerificationBadge"),
    tests: ["tests/finishVerification.test.ts"],
  },
  {
    match: (p) => p.includes("lib/evidenceLinkedSummaries") || p.includes("app/api/chat/route"),
    tests: ["tests/evidenceLinkedSummaries.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/toolCallIntegrity") ||
      p.includes("app/api/chat/route") ||
      p.includes("components/ChatStream"),
    tests: ["tests/toolCallIntegrity.test.ts"],
  },
  // UI-003/UI-011b: live tool-call trace rows during a turn (live strip in
  // ChatStream, LiveRunBlock liveTraces prop, page wiring of live trace state)
  {
    match: (p) =>
      p.includes("components/ChatStream") ||
      p.includes("components/LiveRunBlock") ||
      p.includes("app/page"),
    tests: ["tests/chatLiveTraceRows.test.ts"],
  },
  {
    match: (p) => p.includes("lib/hooks/useLiveTraces") || p.includes("useLiveTraces.test.ts"),
    tests: ["tests/useLiveTraces.test.ts"],
  },
  {
    match: (p) => p.includes("components/ViewShell") || p.includes("viewShell.test.ts"),
    tests: ["tests/viewShell.test.ts"],
  },
  // qa-7 / UI-013: live header context meter — latest round's actual prompt
  // tokens from the record on every client (helper, snapshot carriage, pill)
  {
    match: (p) =>
      p.includes("lib/tokenEconomics") ||
      p.includes("lib/streamSnapshot") ||
      p.includes("components/ChatStream") ||
      p.includes("app/api/chat/route"),
    tests: ["tests/uirLiveMeter.test.ts"],
  },
  // UI Refresh slice 1: chat text fixes — user-text wrap (UI-016), sidebar
  // title wrap (UI-012), long-brief collapse (UI-014)
  {
    match: (p) => p.includes("components/ChatStream") || p.includes("components/ThreadsSidebar"),
    tests: ["tests/uirChatTextFixes.test.ts"],
  },
  // Board parity PR1 (FINAL-DESIGN): header composition + context meter
  // format/geometry + composer/send geometry in ChatStream, formatContextK
  // in tokenEconomics
  {
    match: (p) => p.includes("components/ChatStream") || p.includes("lib/tokenEconomics"),
    tests: ["tests/parityHeaderComposer.test.ts"],
  },
  // Board parity PR2 (FINAL-DESIGN): chat surfaces — brief bubble, thinking
  // card, live trace rows, RUNNING pill, activity header details
  {
    match: (p) =>
      p.includes("components/ChatStream") ||
      p.includes("components/ThinkingPanel") ||
      p.includes("components/LiveRunBlock"),
    tests: ["tests/parityChatSurfaces.test.ts"],
  },
  // Board parity PR3 (FINAL-DESIGN): sessions sidebar + drawer + rail —
  // board session cards, status chips, running-card actions, rail selection
  {
    match: (p) =>
      p.includes("components/ThreadsSidebar") ||
      p.includes("components/NavigationDrawer") ||
      p.endsWith("app/page.tsx"),
    tests: ["tests/paritySidebarDrawer.test.ts"],
  },
  // Board parity PR4 (FINAL-DESIGN + canvas boards): canvas pane/diff form,
  // chat canvas doors, Morning Report verdict/KPI/attention forms, and the
  // UI-021 completed-turn trace surfaces (ExecutionTrace, TraceWaterfall)
  {
    match: (p) =>
      p.includes("components/ArtifactCanvas") ||
      p.includes("components/ArtifactRenderers") ||
      p.includes("components/MorningReportView") ||
      p.includes("components/ExecutionTrace") ||
      p.includes("components/TraceWaterfall"),
    tests: ["tests/parityVerificationPass.test.ts"],
  },
  // Token Economics parts (a)/(c)/(d): per-round prompt tokens + per-job rollup,
  // micro-elision of superseded tool results, and within-thread read dedup
  {
    match: (p) =>
      p.includes("lib/tokenEconomics") ||
      p.includes("lib/microElision") ||
      p.includes("lib/readDedup") ||
      p.includes("app/api/chat/route") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/llm/"),
    tests: [
      "tests/tokenEconomics.test.ts",
      "tests/microElision.test.ts",
      "tests/readDedup.test.ts",
    ],
  },
  // Shared-Volume Permissions Hardening (0770/0660) & Deploy Manifests
  {
    match: (p) =>
      p.includes("permissions") ||
      p.includes("deploy/k8s/mcp-runner") ||
      p.includes("deploy/k8s/web-ui"),
    tests: ["tests/permissions.test.ts"],
  },
  // Artifact canvas (uir-2): core logic, pane, and its card affordances
  {
    match: (p) =>
      p.includes("lib/canvas") ||
      p.includes("components/ArtifactCanvas") ||
      p.includes("components/CanvasContext") ||
      p.includes("components/ArtifactRenderers") ||
      p.includes("components/ChatStream"),
    tests: ["tests/uirCanvas.test.ts", "tests/chatDiffCollapseCanvasSwitch.test.ts"],
  },
  // Unified Agent UI (Material 3) components & design tokens
  {
    match: (p) =>
      p.includes("lib/hooks") ||
      p.includes("components/LiveRunBlock") ||
      p.includes("components/ArtifactRenderers") ||
      p.includes("components/ModelBottomSheet") ||
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
      "tests/thinkingPanel.test.ts",
      "tests/stopTurnFidelity.test.ts",
      "tests/chatReasoningAndProgress.test.ts",
      "tests/threadsLaunchTask.test.ts",
      "tests/unifiedUi.test.ts",
      "tests/oledTrueBlack.test.ts",
      "tests/sessionIntegrity.test.ts",
      "tests/chatPolish.test.ts",
      "tests/taskControls.test.ts",
      "tests/sprint2UiNavigationAndScroll.test.ts",
      "tests/skillsProposeApprove.test.ts",
      "tests/mobileHeaderNav.test.ts",
      "tests/engineToggle.test.ts",
      "tests/shakeoutFixes.test.ts",
      "tests/threadDelete.test.ts",
      "tests/threadDeleteUi.test.ts",
      "tests/projectsNavAndWorkflow.test.ts",
      "tests/selfDeployWiring.test.ts",
      "tests/threadsDeleteTouch.test.ts",
      "tests/uiStateAndDedup.test.ts",
    ],
  },
  {
    match: (p) => p.includes("lib/chatHistory"),
    tests: ["tests/chatHistory.test.ts", "tests/frontendRefreshRehydration.test.ts"],
  },
  // Projects & Folders (Phases 1-4)
  {
    match: (p) =>
      p.includes("lib/projects/") ||
      p.includes("app/api/projects") ||
      p.includes("components/ProjectsView") ||
      p.includes("components/projects/") ||
      p.includes("projectsViewExtraction.test.ts"),
    tests: [
      "tests/projectsRegistryAndExplorer.test.ts",
      "tests/projectOvernightRunner.test.ts",
      "tests/projectDiffReview.test.ts",
      "tests/projectMorningReportIntegration.test.ts",
      "tests/projectsViewExtraction.test.ts",
    ],
  },
  // Memory profile & durable facts
  {
    match: (p) => p.includes("lib/memory"),
    tests: ["tests/userProfile.test.ts"],
  },
  // Persistent storage migration helper
  {
    match: (p) => p.includes("lib/storageMigration"),
    tests: ["tests/ledger.test.ts", "tests/userProfile.test.ts", "tests/flywheelSkills.test.ts"],
  },
  // Skill gate
  {
    match: (p) => p.includes("lib/subagents/skillGate"),
    tests: ["tests/skillGate.test.ts"],
  },
  // Chat route extracted modules
  {
    match: (p) => p.includes("lib/chat/attachments") || p.includes("chatAttachmentHelpers.test.ts"),
    tests: ["tests/chatAttachmentHelpers.test.ts"],
  },
  {
    match: (p) => p.includes("lib/chat/streamMessages") || p.includes("chatStreamMessages.test.ts"),
    tests: ["tests/chatStreamMessages.test.ts", "tests/chatHistory.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/chat/messageRender") || p.includes("chatMessageRender.test.ts"),
    tests: ["tests/chatMessageRender.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/chat/approvals") ||
      p.includes("components/chat/compactionPill") ||
      p.includes("chatApprovalsAndCompaction.test.ts"),
    tests: ["tests/chatApprovalsAndCompaction.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/chat/mcpClients") ||
      p.includes("chatMcpClients.test.ts") ||
      p.includes("mcpClientPoolHardening.test.ts"),
    tests: ["tests/chatMcpClients.test.ts", "tests/mcpClientPoolHardening.test.ts"],
  },
  {
    match: (p) => p.includes("lib/chat/triage") || p.includes("chatTriage.test.ts"),
    tests: ["tests/chatTriage.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/chat/turnEngine") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("app/api/chat/route") ||
      p.includes("lib/board/productionDrain") ||
      p.includes("lib/board/productionStageDeps") ||
      p.includes("lib/llm/provider") ||
      p.includes("lib/hostMode") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/threads/liveness") ||
      p.includes("lib/threads/inAppSupervisor") ||
      p.includes("lib/jobQueue") ||
      p.includes("turnSurvival.test.ts"),
    tests: ["tests/turnSurvival.test.ts"],
  },
  {
    match: (p) => p.includes("lib/chat/turnEngine") || p.includes("chatTurnEngine.test.ts"),
    tests: ["tests/chatTurnEngine.test.ts"],
  },
  {
    match: (p) =>
      p.includes("host-bridge/multiRead") ||
      p.includes("host-bridge/server") ||
      p.includes("lib/hostMode") ||
      p.includes("lib/readDedup") ||
      p.includes("hostMultiRead.test.ts"),
    tests: ["tests/hostMultiRead.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/chat/toolFanout") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("roundToolFanout.test.ts"),
    tests: ["tests/roundToolFanout.test.ts"],
  },
  {
    // Board #125 Perf P2: parallel read-only fanout partition + single-round trace contract
    match: (p) =>
      p.includes("lib/chat/toolFanout") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/llm/provider") ||
      p.includes("parallelReadOnlyFanout.test.ts"),
    tests: ["tests/parallelReadOnlyFanout.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/chat/roundLoop") ||
      p.includes("app/api/chat/route") ||
      p.includes("chatRoundLoop.test.ts"),
    tests: ["tests/chatRoundLoop.test.ts"],
  },
  // Chat API route and progressive tools
  {
    match: (p) =>
      p.includes("app/api/chat/route") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/progressiveTools") ||
      p.includes("lib/conversationCompaction"),
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
      "tests/llmProvider.test.ts",
      "tests/chatFilePaging.test.ts",
      "tests/chatTurnHonesty.test.ts",
      "tests/chatTextTruth.test.ts",
      "tests/chatPersistenceDecoupling.test.ts",
      "tests/chatLiveVisibility.test.ts",
      "tests/synthesisRetry.test.ts",
      "tests/hybridCompaction.test.ts",
      "tests/chatRoundBudget.test.ts",
      "tests/chatToolDegradation.test.ts",
      "tests/chatTurnPresence.test.ts",
      "tests/chatThinkingPreservation.test.ts",
      "tests/thread-list-summaries.test.ts",
      "tests/threadStoreCheapSweep.test.ts",
      "tests/thread-list-loading-and-selection.test.ts",
      "tests/thread-search-snippet.test.ts",
      "tests/live-meter-done-parity.test.ts",
      "tests/chatWebResearchCap.test.ts",
    ],
  },
  // LLM Provider abstraction, standalone supervisor & engine control
  {
    match: (p) =>
      p.includes("lib/llm/") ||
      p.includes("scripts/llamacpp-standalone") ||
      p.includes("app/api/engine") ||
      p.includes("components/EngineStatusPill") ||
      p.includes("app/api/sandbox-status/route"),
    tests: [
      "tests/llmProvider.test.ts",
      "tests/engineRoute.test.ts",
      "tests/engineToggle.test.ts",
      "tests/shakeoutFixes.test.ts",
    ],
  },
  {
    match: (p) =>
      p.includes("components/BoardView") ||
      p.includes("components/ThreadsSidebar") ||
      p.includes("components/ChatStream") ||
      p.includes("uiPolishBatch8.test.ts"),
    tests: ["tests/uiPolishBatch8.test.ts"],
  },
  // Tasks API route
  {
    match: (p) => p.includes("app/api/tasks/route"),
    tests: [
      "tests/tasksApi.test.ts",
      "tests/activeTaskRehydration.test.ts",
      "tests/taskControls.test.ts",
      "tests/buildLaunchVisibility.test.ts",
    ],
  },
  // Files API route, Workspace File alias & thread outputs
  {
    match: (p) =>
      p.includes("app/api/files/route") ||
      p.includes("lib/threadOutputs") ||
      p.includes("app/api/workspace/file"),
    tests: [
      "tests/filesApi.test.ts",
      "tests/chatAttachments.test.ts",
      "tests/svgRendering.test.ts",
      "tests/punchlistBackendFixes.test.ts",
    ],
  },
  // Patch Core surgical utility
  {
    match: (p) => p.includes("lib/subagents/patchCore"),
    tests: ["tests/punchlistBackendFixes.test.ts"],
  },
  // Subagents & Supervisor
  {
    match: (p) =>
      p.includes("lib/subagents/checkpointSaver") || p.includes("checkpointSaver.test.ts"),
    tests: ["tests/checkpointSaver.test.ts", "tests/langgraphSupervisorNodes.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/stepExecutor") || p.includes("stepExecutor.test.ts"),
    tests: [
      "tests/stepExecutor.test.ts",
      "tests/productionTestRunnerWiring.test.ts",
      "tests/canonicalLifecycle.test.ts",
      "tests/punchlistBackendFixes.test.ts",
    ],
  },
  {
    match: (p) => p.includes("lib/subagents/verification") || p.includes("verification.test.ts"),
    tests: ["tests/verification.test.ts", "tests/p3FinishAndHandoffWiring.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/probes") || p.includes("probes.test.ts"),
    tests: ["tests/probes.test.ts", "tests/langgraphSupervisorNodes.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/subagents/overnightGraph") || p.includes("overnightGraph.test.ts"),
    tests: ["tests/overnightGraph.test.ts", "tests/langgraphSupervisorNodes.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/supervisor"),
    tests: [
      "tests/supervisor.test.ts",
      "tests/canonicalLifecycle.test.ts",
      "tests/taskCompletion.test.ts",
      "tests/browserMcpConnectivity.test.ts",
      "tests/activeTaskRehydration.test.ts",
      "tests/taskControls.test.ts",
      "tests/buildLaunchVisibility.test.ts",
      "tests/buildPushHonesty.test.ts",
      "tests/plannerScope.test.ts",
      "tests/productionTestRunnerWiring.test.ts",
      "tests/threadsResumeRestartExecution.test.ts",
      "tests/supervisorGitOpsIntegration.test.ts",
      "tests/taskPathObservability.test.ts",
      "tests/taskPathExecutionFix.test.ts",
      "tests/completionGateAndPlanningAbort.test.ts",
    ],
  },
  {
    match: (p) =>
      p.includes("taskPathExecutionFix.test.ts") ||
      p.includes("lib/git/workerGitOps") ||
      p.includes("lib/subagents/planner") ||
      p.includes("lib/subagents/workerPool") ||
      p.includes("lib/llm/provider") ||
      p.includes("lib/jobChunking") ||
      p.includes("app/api/threads/route") ||
      p.includes("app/api/threads/[id]/route") ||
      p.includes("lib/threads/threadStore"),
    tests: ["tests/taskPathExecutionFix.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/threads/inAppSupervisor") ||
      p.includes("inAppSupervisor.test.ts") ||
      p.includes("inAppSupervisorWiring.test.ts"),
    tests: ["tests/inAppSupervisor.test.ts", "tests/inAppSupervisorWiring.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/SupervisorStatusBadge") ||
      p.includes("components/supervisorBadgeState") ||
      p.includes("supervisorStatusBadge.test.ts") ||
      p.includes("supervisorStatusBadgeWiring.test.ts"),
    tests: ["tests/supervisorStatusBadge.test.ts", "tests/supervisorStatusBadgeWiring.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/workerPool"),
    tests: [
      "tests/workerPool.test.ts",
      "tests/workerPoolIsolation.test.ts",
      "tests/critic.test.ts",
      "tests/workerHonesty.test.ts",
      "tests/langgraphSupervisorNodes.test.ts",
      "tests/blockingGateRevert.test.ts",
      "tests/modelRoster.test.ts",
      "tests/evidenceLinking.test.ts",
      "tests/explorerAndCriticUpgrade.test.ts",
      "tests/plannerScope.test.ts",
    ],
  },
  {
    match: (p) => p.includes("lib/subagents/llmClient"),
    tests: ["tests/workerHonesty.test.ts", "tests/workerPool.test.ts", "tests/llmClient.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/residency"),
    tests: ["tests/workerHonesty.test.ts", "tests/vramResidencyAndMultiFile.test.ts"],
  },
  {
    match: (p) => p.includes("lib/subagents/planner"),
    tests: [
      "tests/planner.test.ts",
      "tests/shakeoutFixes.test.ts",
      "tests/plannerScope.test.ts",
      "tests/explorerAndCriticUpgrade.test.ts",
      "tests/buildLaunchVisibility.test.ts",
    ],
  },
  {
    match: (p) =>
      p.includes("lib/subagents/morningReport") || p.includes("lib/subagents/failureSummary"),
    tests: [
      "tests/morningReport.test.ts",
      "tests/realReportTestCounts.test.ts",
      "tests/buildPushHonesty.test.ts",
    ],
  },
  {
    match: (p) => p.includes("lib/subagents/types"),
    tests: [
      "tests/supervisor.test.ts",
      "tests/workerPool.test.ts",
      "tests/scheduler.test.ts",
      "tests/morningReport.test.ts",
      "tests/buildPushHonesty.test.ts",
      "tests/evidenceLinking.test.ts",
      "tests/explorerAndCriticUpgrade.test.ts",
      "tests/productionTestRunnerWiring.test.ts",
      "tests/threadsResumeRestartExecution.test.ts",
    ],
  },
  {
    match: (p) =>
      p.includes("lib/subagents/scheduler") ||
      p.includes("app/api/schedules") ||
      p.includes("app/api/scheduler"),
    tests: [
      "tests/scheduler.test.ts",
      "tests/schedulerApi.test.ts",
      "tests/shakeoutFixes.test.ts",
      "tests/schedulerDaemon.test.ts",
      "tests/schedulerHealth.test.ts",
    ],
  },
  // Telemetry, Tool Parser, File Parser
  {
    match: (p) => p.includes("lib/telemetry"),
    tests: ["tests/telemetry.test.ts"],
  },
  {
    match: (p) => p.includes("lib/toolParser"),
    tests: ["tests/toolParser.test.ts"],
  },
  {
    match: (p) => p.includes("lib/retryAfter"),
    tests: ["tests/retryAfter.test.ts"],
  },
  {
    match: (p) => p.includes("lib/fileParser") || p.includes("lib/visionProcessor"),
    tests: ["tests/fileParser.test.ts"],
  },
  // Ingestion
  {
    match: (p) => p.includes("lib/ingestion"),
    tests: ["tests/ingestionPipeline.test.ts"],
  },
  // Models config & modelfiles
  {
    match: (p) =>
      p.includes("config/models") || p.includes("deploy/modelfiles") || p.includes("Modelfile"),
    tests: ["tests/models.test.ts", "tests/modelfiles.test.ts"],
  },
  // Makefile deployment configuration
  {
    match: (p) => p === "Makefile" || p.endsWith("/Makefile"),
    tests: ["tests/deploymentConfig.test.ts"],
  },
  // Sandbox tier runner
  {
    match: (p) => p.includes("lib/sandbox/tierRunner"),
    tests: ["tests/buildSandboxTier.test.ts"],
  },
  // Oracle ingestion
  {
    match: (p) => p.includes("lib/oracle/ingestion") || p.includes("lib/ingestion"),
    tests: ["tests/ingestionPipeline.test.ts"],
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
      "tests/dogfoodToolchain.test.ts",
    ],
  },
  // UI views and components
  {
    match: (p) =>
      p.includes("components/MorningReportView") ||
      p.includes("app/morning-report") ||
      p.includes("app/api/morning-report"),
    tests: [
      "tests/morningReport.test.ts",
      "tests/realReportTestCounts.test.ts",
      "tests/morningReportViewRestructure.test.ts",
    ],
  },
  // Run Ledger & Run Controls (Sprint 12 Phase 4)
  {
    match: (p) => p.includes("lib/ledger/"),
    tests: [
      "tests/ledger.test.ts",
      "tests/ledgerStats.test.ts",
      "tests/pause_resume.test.ts",
      "tests/restart.test.ts",
      "tests/crash_recovery.test.ts",
    ],
  },
  // Deploy API (Sprint 7)
  {
    match: (p) =>
      p.includes("app/api/deploy") ||
      p.includes("components/LiveRunBlock") ||
      p.includes("lib/deploy/dryRunUrlGuard") ||
      p.includes("deployDryRunUrlGuard.test.ts"),
    tests: ["tests/deployApiWiring.test.ts", "tests/deployDryRunUrlGuard.test.ts"],
  },
  // Build Deploy Flow (Sprint 12 Phase 5)
  {
    match: (p) => p.includes("lib/deploy/"),
    tests: ["tests/deployFlow.test.ts"],
  },
  // Human Skill Gates (Sprint 3)
  {
    match: (p) =>
      p.includes("app/api/skills") ||
      p.includes("components/SkillsView") ||
      p.includes("lib/subagents/skillGate"),
    tests: [
      "tests/humanSkillGates.test.ts",
      "tests/skillsProposeApprove.test.ts",
      "tests/skillsViewPreview.test.ts",
    ],
  },
  // Flywheel Skills Spike (Sprint 12 Phase 7)
  {
    match: (p) => p.includes("lib/flywheel/"),
    tests: ["tests/flywheelSkills.test.ts"],
  },
  // Worker Git Operations (Sprint 12 Phase 8)
  {
    match: (p) => p.includes("lib/git/"),
    tests: [
      "tests/workerGitOps.test.ts",
      "tests/buildPushHonesty.test.ts",
      "tests/supervisorGitOpsIntegration.test.ts",
    ],
  },
  // Worker CI Feedback (Sprint 12 Phase 9)
  {
    match: (p) => p.includes("lib/ci/"),
    tests: ["tests/workerCiFeedback.test.ts", "tests/productionTestRunnerWiring.test.ts"],
  },
  {
    match: (p) => p.includes("lib/deploy/selfDeployVerified"),
    tests: ["tests/selfDeployVerified.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/DiffViewer") ||
      p.includes("components/ThinkingPanel") ||
      p.includes("next.config"),
    tests: ["tests/uiPolishPass2.test.ts"],
  },
  // Self-Deploy Pipeline (Sprint 12 Phase 10)
  {
    match: (p) => p.includes("lib/deploy/selfDeploy"),
    tests: ["tests/selfDeploy.test.ts"],
  },
  {
    match: (p) => p.includes("components/ChatStream"),
    tests: [
      "tests/chatStreaming.test.ts",
      "tests/chatReasoningAndProgress.test.ts",
      "tests/chatLiveVisibility.test.ts",
      "tests/chatStreamTokenPreservation.test.ts",
      "tests/fix5NarrationAndProse.test.ts",
      "tests/p21ToolCallIntegrity.test.ts",
      "tests/p22PatchAndDialect.test.ts",
      "tests/p32AndP33SupervisorGates.test.ts",

      "tests/p5BoardAndPipeline.test.ts",
      "tests/p6SecurityDeployEvalIngestion.test.ts",
      "tests/chatQueue.test.ts",
      "tests/punchlistUiFixes.test.ts",
      "tests/uiStateAndDedup.test.ts",
    ],
  },
  // CHAT-8 live streaming visibility (server snapshots + client poll loop)
  {
    match: (p) => p.includes("lib/streamSnapshot") || p.includes("app/page"),
    tests: ["tests/chatLiveVisibility.test.ts", "tests/chatThinkingPreservation.test.ts"],
  },
  // CHAT-QUEUE client-side message queue
  {
    match: (p) => p.includes("lib/chatQueue"),
    tests: ["tests/chatQueue.test.ts"],
  },
  // Turn delivery & client reconciliation
  {
    match: (p) => p.includes("lib/turnReconciliation") || p.includes("turnDeliveryReconciliation"),
    tests: ["tests/turnDeliveryReconciliation.test.ts"],
  },
  // UI-006/UI-006b reconcile-poll backoff policy (ChatStream poll loop gating)
  {
    match: (p) => p.includes("lib/reconcilePollPolicy") || p.includes("reconcilePollBackoff"),
    tests: ["tests/reconcilePollBackoff.test.ts"],
  },
  // CHAT-STEER mid-turn server steer mailbox
  {
    match: (p) => p.includes("app/api/threads") && p.includes("steer"),
    tests: ["tests/chatSteer.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/DiffViewer") ||
      p.includes("components/ExecutionTrace") ||
      p.includes("app/page.tsx") ||
      p.includes("app/layout.tsx"),
    tests: [
      "tests/frontendRefreshRehydration.test.ts",
      "tests/chatHistory.test.ts",
      "tests/chatStreaming.test.ts",
      "tests/artifactDeliveryAndPolish.test.ts",
      "tests/projectsNavAndWorkflow.test.ts",
      "tests/selfDeployWiring.test.ts",
      "tests/traceRowAccessibleNames.test.ts",
      "tests/chatDiffCollapseCanvasSwitch.test.ts",
    ],
  },
  // MCP server files
  {
    match: (p) => p.startsWith("mcp-server/"),
    tests: ["mcp-server:tests"],
  },
  // Browser MCP files
  {
    match: (p) => p.startsWith("browser-mcp/"),
    tests: ["browser-mcp:tests"],
  },
  // Test gate itself
  {
    match: (p) => p.includes("lib/testGate") || p.includes("scripts/test-gate"),
    tests: [
      "tests/testGate.test.ts",
      "tests/gateManifestCompleteness.test.ts",
      "tests/testGateRunner.test.ts",
    ],
  },
  // Overnight dogfood runner
  {
    match: (p) => p.includes("scripts/run-dogfood-overnight"),
    tests: ["tests/dogfoodPhase1Acceptance.test.ts", "tests/realReportTestCounts.test.ts"],
  },
  // Memory evaluation, ingestion and verification scripts
  {
    match: (p) =>
      p.includes("scripts/eval-memory") ||
      p.includes("scripts/ingest-docs") ||
      p.includes("scripts/verify-phase-d") ||
      p.includes("eval/"),
    tests: ["tests/skillGate.test.ts"],
  },
  {
    match: (p) => p.includes("scripts/verify-phase-c"),
    tests: ["tests/userProfile.test.ts"],
  },
  {
    match: (p) => p.includes("scripts/verify-lan-copy"),
    tests: ["tests/clipboard.test.ts"],
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
    tests: ["tests/e2eScriptTimeouts.test.ts"],
  },
  // Architecture diagrams
  {
    match: (p) => p.includes("docs/architecture.drawio"),
    tests: ["tests/architectureSvgPair.test.ts", "tests/dogfoodPhase1Acceptance.test.ts"],
  },
  // Package manifests
  {
    match: (p) => p.endsWith("package.json") || p.endsWith("tsconfig.json"),
    tests: ["tests/tasksApi.test.ts", "tests/supervisor.test.ts"],
  },
  // Settings Memory store, API route, prompt injection, and Settings card
  {
    match: (p) => p.includes("lib/memory/operatorMemory") || p.includes("app/api/settings/memory"),
    tests: ["tests/operatorMemory.test.ts", "tests/operatorMemoryInjection.test.ts"],
  },
  {
    match: (p) => p.includes("app/api/chat/route"),
    tests: ["tests/operatorMemoryInjection.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/SettingsView") ||
      p.includes("components/settings/") ||
      p.includes("settingsZoneComponents.test.ts"),
    tests: [
      "tests/settingsMemoryUi.test.ts",
      "tests/settingsZones.test.ts",
      "tests/settingsZoneComponents.test.ts",
    ],
  },
  // Repository hygiene & documentation integrity (Sprint 4 & 5)
  {
    match: (p) =>
      p === "LICENSE" || p.includes(".opencode-remote-session") || p.includes("triage-report"),
    tests: ["tests/repoHygiene.test.ts", "tests/docsIntegrity.test.ts"],
  },
  {
    match: (p) => p.includes("deploy/k8s/observability.yaml"),
    tests: ["tests/otelJaegerDedup.test.ts"],
  },
  // Charter modules (P0.1)
  {
    match: (p) => p.includes("lib/liveStatus"),
    tests: ["tests/liveStatus.test.ts"],
  },
  {
    match: (p) => p.includes("lib/executionSummary"),
    tests: ["tests/executionSummary.test.ts"],
  },
  {
    match: (p) => p.includes("lib/modelEval"),
    tests: ["tests/modelEval.test.ts"],
  },
  {
    match: (p) => p.includes("lib/fsAtomic"),
    tests: ["tests/boardStore.test.ts", "tests/schedulerPlanner.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/boardStore"),
    tests: ["tests/boardStore.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/dispatcher"),
    tests: ["tests/dispatcher.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/flowMonitor"),
    tests: ["tests/flowMonitor.test.ts"],
  },
  {
    match: (p) => p.includes("lib/board/reviewerGate"),
    tests: ["tests/reviewerGate.test.ts"],
  },
  {
    match: (p) =>
      p.includes("config/models") ||
      p.includes("lib/chatUtils") ||
      p.includes("lib/subagents/llmClient"),
    tests: ["tests/p02ModelEffort.test.ts"],
  },
  {
    match: (p) => p.includes("lib/threads/threadStore"),
    tests: ["tests/p03DataLoss.test.ts"],
  },
  {
    match: (p) =>
      p.includes("app/globals.css") || p.includes("app/layout.tsx") || p.includes("app/error.tsx"),
    tests: ["tests/p04VisualGuard.test.ts"],
  },
  {
    match: (p) => p.includes("app/page.tsx") || p.includes("components/SettingsView"),
    tests: ["tests/p05StrayUi.test.ts"],
  },
  {
    match: (p) => p === "retryAfter.mjs" || p === "tests/retryAfter.test.mjs",
    tests: ["../tests/retryAfter.test.mjs"],
  },
  {
    match: (p) => p.includes("app/api/traces/route") || p.includes("tracesRoute.test.ts"),
    tests: ["tests/tracesRoute.test.ts"],
  },
  {
    // PERF-P3: thought stream delta-only. Thinking tokens emit only the
    // `thinking` delta; cumulative `thought` fires at round boundaries only.
    match: (p) =>
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/chat/turnEngine") ||
      p.includes("thoughtStreamDeltaOnly.test.ts"),
    tests: ["tests/thoughtStreamDeltaOnly.test.ts"],
  },
  {
    // Board #129 Perf P5: mid-turn compaction uses the extraction digest (no
    // secondary summarization dispatch on the single engine slot), and the
    // turn's slot lease releases during tool waits so a queued turn dispatches.
    match: (p) =>
      p.includes("lib/conversationCompaction") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/jobQueue") ||
      p.includes("lib/slotScheduler") ||
      p.includes("lib/chatTurnGate") ||
      p.includes("app/api/chat/route") ||
      p.includes("engineSlotReleaseDuringToolWait.test.ts"),
    tests: ["tests/engineSlotReleaseDuringToolWait.test.ts"],
  },
  {
    // PERF-P4 (#128): snapshot cadence raised to 5s; full-thread poll suppressed
    // while the SSE stream is actively delivering chunks.
    match: (p) =>
      p.includes("lib/streamSnapshot") ||
      p.includes("lib/streamPollGate") ||
      p.includes("app/page.tsx") ||
      p.includes("app/api/chat/route") ||
      p.includes("snapshotIntervalFiveSeconds.test.ts"),
    tests: [
      "tests/snapshotIntervalFiveSeconds.test.ts",
      "tests/chatLiveVisibility.test.ts",
      "tests/chatThinkingPreservation.test.ts",
    ],
  },
  {
    // PERF-P4 (#128): poll-gate predicate extracted as a pure function.
    match: (p) =>
      p.includes("lib/streamPollGate") ||
      p.includes("app/page.tsx") ||
      p.includes("streamPollGate.test.ts"),
    tests: ["tests/streamPollGate.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/streamSnapshot") ||
      p.includes("components/ChatStream") ||
      p.includes("heartbeatWrites.test.ts"),
    tests: ["tests/heartbeatWrites.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/threads/types") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("components/ThreadsSidebar") ||
      p.includes("components/chat/messageRender") ||
      p.includes("components/ActivityTimeline") ||
      p.includes("lib/chatUtils") ||
      p.includes("components/SchedulesPanel") ||
      p.includes("app/api/schedules") ||
      p.includes("app/api/scheduler/health") ||
      p.includes("lib/subagents/scheduler") ||
      p.includes("lib/board/boardStore") ||
      p.includes("app/api/board/route") ||
      p.includes("components/BoardView") ||
      p.includes("components/BuildsView") ||
      p.includes("components/ExecutionTrace") ||
      p.includes("components/SandboxGauge") ||
      p.includes("components/ModelBottomSheet") ||
      p.includes("components/MorningReportView") ||
      p.includes("components/ViewShell") ||
      p.includes("app/morning-report/page") ||
      p.includes("components/SkillsView") ||
      p.includes("app/api/skills/route") ||
      p.includes("lib/subagents/skillGate") ||
      p.includes("components/SettingsView") ||
      p.includes("app/page.tsx") ||
      p.includes("uiClosures.test.ts"),
    tests: ["tests/uiClosures.test.ts"],
  },
  {
    match: (p) =>
      p.includes("app/page.tsx") ||
      p.includes("app/api/skills/route") ||
      p.includes("lib/flywheel/skillsStore") ||
      p.includes("lib/hostMode") ||
      p.includes("lib/hostSettings") ||
      p.includes("lib/chat/mcpClients") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/readDedup") ||
      p.includes("backgroundLoadPerf.test.ts"),
    tests: ["tests/backgroundLoadPerf.test.ts"],
  },
  {
    match: (p) =>
      p.includes("wireDeadActions.test.ts") ||
      p.includes("components/ChatStream") ||
      p.includes("app/page.tsx") ||
      p.includes("app/api/threads/[id]/route") ||
      p.includes("app/api/threads/[id]/compact/route") ||
      p.includes("app/api/projects/[id]/tasks/route") ||
      p.includes("lib/projects/projectRunner") ||
      p.includes("lib/projects/projectStore") ||
      p.includes("components/ProjectsView") ||
      p.includes("components/projects/ProjectTaskList"),
    tests: ["tests/wireDeadActions.test.ts"],
  },
  {
    match: (p) =>
      p.includes("lib/apiJson") ||
      p.includes("lib/subagents/scheduler") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("lib/chat/roundLoop") ||
      p.includes("lib/jobChunking") ||
      p.includes("lib/chat/mcpClients") ||
      p.includes("lib/board/boardOrchestrator") ||
      p.includes("app/api/board/intake/route") ||
      p.includes("app/api/deploy/route") ||
      p.includes("app/api/settings/host/route") ||
      p.includes("app/api/settings/memory/route") ||
      p.includes("app/api/settings/notifications/route") ||
      p.includes("app/api/skills/route") ||
      p.includes("app/api/tasks/route") ||
      p.includes("app/api/schedules/route") ||
      p.includes("app/api/threads/route") ||
      p.includes("app/api/threads/[id]/route") ||
      p.includes("app/api/projects/browse/route") ||
      p.includes("schedulerHygiene.test.ts"),
    tests: ["tests/schedulerHygiene.test.ts"],
  },
  {
    match: (p) =>
      p.includes("components/chat/messageRender") ||
      p.includes("components/ActivityTimeline") ||
      p.includes("components/StintCard") ||
      p.includes("components/ChatStream") ||
      p.includes("lib/stintDerivation") ||
      p.includes("lib/chatStatus") ||
      p.includes("renderMemoization.test.ts"),
    tests: ["tests/renderMemoization.test.ts"],
  },
  {
    match: (p) =>
      p.includes("app/api/files/route") ||
      p.includes("lib/threads/threadStore") ||
      p.includes("app/api/threads/") ||
      p.includes("lib/subagents/skillGate") ||
      p.includes("app/api/skills/route") ||
      p.includes("app/api/projects/browse/route") ||
      p.includes("app/api/deploy/route") ||
      p.includes("lib/deploy/selfDeploy") ||
      p.includes("lib/projects/projectGit") ||
      p.includes("apiPathGuards.test.ts"),
    tests: ["tests/apiPathGuards.test.ts"],
  },
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
    normalizedPath.endsWith(".editorconfig") ||
    normalizedPath.endsWith(".prettierignore") ||
    normalizedPath.endsWith(".prettierrc.json") ||
    normalizedPath.endsWith("package-lock.json") ||
    normalizedPath.includes("Dockerfile") ||
    normalizedPath.startsWith("docker-compose") ||
    normalizedPath.startsWith("deploy/") ||
    normalizedPath.startsWith("helm/") ||
    normalizedPath.startsWith(".github/") ||
    normalizedPath.includes(".tmp") ||
    /(?:^|\/)temp-/.test(normalizedPath) ||
    normalizedPath.includes(".agent") ||
    normalizedPath.includes("playwright-report") ||
    normalizedPath.includes("playwright-live-report") ||
    normalizedPath.includes("test-results") ||
    normalizedPath.endsWith("full-suite-results.json") ||
    normalizedPath.startsWith("scripts/lan-bridge") ||
    normalizedPath.startsWith("scripts/dev-proxy") ||
    normalizedPath.startsWith("scripts/bench-") ||
    normalizedPath.startsWith("scripts/test-q3") ||
    normalizedPath.startsWith("scripts/test-ui-render") ||
    normalizedPath.startsWith("scripts/test-acceptance") ||
    normalizedPath.startsWith("scripts/test-all") ||
    normalizedPath.startsWith("scripts/shakeout") ||
    normalizedPath.startsWith("scripts/start-strata") ||
    normalizedPath.startsWith("scripts/stop-strata") ||
    normalizedPath === "scripts/deploy-cluster.js" ||
    normalizedPath.startsWith("scripts/Start-HostRunner") ||
    normalizedPath.includes("playwright.config") ||
    normalizedPath.includes("playwright.live.config") ||
    normalizedPath.endsWith("vitest.config.ts") ||
    normalizedPath.endsWith("eslint.config.mjs") ||
    normalizedPath.startsWith(".husky/") ||
    normalizedPath.includes("test-results") ||
    normalizedPath.includes("playwright-report") ||
    normalizedPath.includes("playwright-live-report") ||
    normalizedPath.includes("tests/e2e/") ||
    normalizedPath.includes("tests/e2e-live/") ||
    normalizedPath.includes("tests-live/") ||
    normalizedPath.endsWith(".live.ts") ||
    normalizedPath.startsWith("docs/") ||
    normalizedPath.includes("/.user_uploaded/") ||
    normalizedPath.endsWith("script.py") ||
    normalizedPath.endsWith(".py")
  ) {
    // Exceptions: covered files in otherwise ignored paths
    if (normalizedPath.includes("architecture.drawio")) return false;
    if (
      normalizedPath.startsWith("deploy/k8s/mcp-runner.yaml") ||
      normalizedPath.startsWith("deploy/k8s/web-ui.yaml")
    )
      return false;
    if (
      normalizedPath.startsWith("scripts/dev-proxy") ||
      normalizedPath.startsWith("scripts/lan-bridge")
    )
      return false;
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

    // Direct test file changed (web-ui tests only; workspace tests map via MAPPING_RULES)
    if (
      !normalized.startsWith("browser-mcp/") &&
      !normalized.startsWith("mcp-server/") &&
      /tests\/[^/]+\.test\.(ts|js)$/.test(normalized)
    ) {
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
    ignoredFiles: ignored,
  };
}

/**
 * Inspects git to retrieve changed files (uncommitted + recent branch commits).
 */
export function getGitChangedFiles(repoRoot?: string, sinceRef?: string): string[] {
  const root =
    repoRoot ||
    path.resolve(process.cwd(), fs.existsSync(path.join(process.cwd(), "web-ui")) ? "." : "..");
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
        baseSha = execSync("git merge-base HEAD origin/develop", {
          cwd: root,
          encoding: "utf8",
        }).trim();
      } catch {
        try {
          baseSha = execSync("git merge-base HEAD origin/main", {
            cwd: root,
            encoding: "utf8",
          }).trim();
        } catch {
          baseSha = "HEAD~1";
        }
      }

      if (baseSha) {
        const diffOut = execSync(`git diff --name-only ${baseSha}..HEAD`, {
          cwd: root,
          encoding: "utf8",
        });
        for (const line of diffOut.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) files.add(trimmed);
        }
      }
    }
  } catch (err: unknown) {
    console.warn(
      "[test:gate] Notice: error inspecting git diff:",
      err instanceof Error ? err.message : String(err)
    );
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

/** Dedicated 15-minute timeout for the Playwright e2e stage (excluded from the 90s unit budget). */
export const PLAYWRIGHT_STAGE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Partitions web-ui test paths into Playwright e2e specs (`tests/e2e/*.spec.ts`)
 * and tsx unit/integration tests.
 */
export function partitionWebUiTests(tests: string[]): {
  playwrightSpecs: string[];
  tsxTests: string[];
} {
  const playwrightSpecs: string[] = [];
  const tsxTests: string[] = [];

  for (const testPath of tests) {
    const normalized = testPath.replace(/\\/g, "/");
    if (normalized.includes("tests/e2e/") && normalized.endsWith(".spec.ts")) {
      playwrightSpecs.push(testPath);
    } else {
      tsxTests.push(testPath);
    }
  }

  return { playwrightSpecs, tsxTests };
}

/**
 * Parses Playwright's JSON reporter output (`playwright-report/test-results.json`).
 * Throws on missing, malformed, or incomplete reports so failures are never masked as zeros.
 */
export function parsePlaywrightReport(reportPath: string): { passed: number; failed: number } {
  const raw = fs.readFileSync(reportPath, "utf8");
  const parsed = JSON.parse(raw) as {
    errors?: unknown[];
    stats?: {
      expected?: unknown;
      unexpected?: unknown;
      flaky?: unknown;
    };
  };

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.stats ||
    typeof parsed.stats !== "object" ||
    typeof parsed.stats.expected !== "number" ||
    typeof parsed.stats.unexpected !== "number"
  ) {
    throw new Error(`Invalid Playwright JSON report structure at ${reportPath}`);
  }

  const passed =
    parsed.stats.expected + (typeof parsed.stats.flaky === "number" ? parsed.stats.flaky : 0);
  const topLevelErrors = Array.isArray(parsed.errors) ? parsed.errors.length : 0;
  const failed =
    parsed.stats.unexpected +
    (parsed.stats.unexpected === 0 && topLevelErrors > 0 ? topLevelErrors : 0);

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
      error: errorMsg,
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
      uncoveredFiles: [],
      stages: ["tsc --noEmit", "tests"],
    };
  }

  const repoRoot = options.repoRoot || ANCHORED_REPO_ROOT;
  const webUiCwd = options.repoRoot
    ? path.resolve(options.repoRoot, "web-ui")
    : ANCHORED_WEB_UI_ROOT;
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
  let playwrightDurationMs = 0;

  const { playwrightSpecs, tsxTests } = partitionWebUiTests(webUiTestsToRun);

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  if (!childEnv.FORCE_MOCK) childEnv.FORCE_MOCK = "1";
  if (!childEnv.FAST_GRAPH_TEST) childEnv.FAST_GRAPH_TEST = "1";

  // 0. Run TypeScript typecheck (tsc --noEmit) for web-ui
  try {
    const remainingTime = Math.max(
      1,
      budgetSeconds * 1000 - (Date.now() - startTime - playwrightDurationMs)
    );
    const tscOut = execSync("npx tsc --noEmit", {
      cwd: webUiCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      timeout: remainingTime,
    });
    if (tscOut) testOutput += tscOut;
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = e.stdout ? e.stdout.toString() : "";
    const stderr = e.stderr ? e.stderr.toString() : "";
    testOutput += `${stdout}\n${stderr}`;
    failedCount += 1;
    runError = `TypeScript typecheck (tsc --noEmit) failed: ${e.message ?? String(err)}`;
  }

  // 1. Run web-ui tsx tests in batches to stay safely under Windows command-line limits
  if (tsxTests.length > 0) {
    const tsxCli = resolveTsxCliPath(webUiCwd, repoRoot);
    for (let i = 0; i < tsxTests.length; i += TSX_TEST_BATCH_SIZE) {
      const batch = tsxTests.slice(i, i + TSX_TEST_BATCH_SIZE);
      try {
        const remainingTime = Math.max(
          1,
          budgetSeconds * 1000 - (Date.now() - startTime - playwrightDurationMs)
        );
        const out = tsxCli
          ? execFileSync(
              process.execPath,
              [tsxCli, "--tsconfig", "tsconfig.json", "--test", ...batch],
              {
                cwd: webUiCwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                env: childEnv,
                timeout: remainingTime,
              }
            )
          : execSync(`npx tsx --tsconfig tsconfig.json --test ${batch.join(" ")}`, {
              cwd: webUiCwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              env: childEnv,
              timeout: remainingTime,
            });
        testOutput += out;
        const counts = parseTapCounts(out);
        if (counts.passed === 0 && counts.failed === 0) {
          failedCount += 1;
          runError = runError ?? "web-ui test runner produced unparseable TAP output";
        } else {
          passedCount += counts.passed;
          failedCount += counts.failed;
        }
      } catch (err: unknown) {
        const e = err as {
          stdout?: Buffer | string;
          stderr?: Buffer | string;
          message?: string;
          code?: string;
        };
        const stdout = e.stdout ? e.stdout.toString() : "";
        const stderr = e.stderr ? e.stderr.toString() : "";
        const batchOutput = `${stdout}\n${stderr}`;
        testOutput += batchOutput;
        const counts = parseTapCounts(batchOutput);
        if (counts.passed === 0 && counts.failed === 0) {
          failedCount += 1;
        } else {
          passedCount += counts.passed;
          failedCount += counts.failed > 0 ? counts.failed : 1;
        }
        runError = runError ?? e.message ?? String(err);
        if (
          e.code === "ETIMEDOUT" ||
          (e.message && (e.message.includes("ETIMEDOUT") || e.message.includes("timed out")))
        ) {
          break;
        }
      }
    }
  }

  // 1b. Run Playwright e2e specs if any mapped (dedicated timeout, excluded from 90s unit budget)
  if (playwrightSpecs.length > 0) {
    const pwStart = Date.now();
    try {
      const buildIdPath = path.join(webUiCwd, ".next", "BUILD_ID");
      let buildOk = fs.existsSync(buildIdPath);
      if (!buildOk) {
        try {
          const buildOut = execSync("npm run build", {
            cwd: webUiCwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: childEnv,
            timeout: PLAYWRIGHT_STAGE_TIMEOUT_MS,
          });
          testOutput += `\n--- Playwright Stage Build ---\n${buildOut}`;
          buildOk = true;
        } catch (err: unknown) {
          const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
          const stdout = e.stdout ? e.stdout.toString() : "";
          const stderr = e.stderr ? e.stderr.toString() : "";
          testOutput += `\n--- Playwright Stage Build Failure ---\n${stdout}\n${stderr}`;
          failedCount += 1;
          runError = `Playwright pre-build failed: ${e.message ?? String(err)}`;
        }
      }

      if (buildOk) {
        const reportPath = path.join(webUiCwd, "playwright-report", "test-results.json");
        const pwRemainingMs = Math.max(1, PLAYWRIGHT_STAGE_TIMEOUT_MS - (Date.now() - pwStart));
        const cmd = `npx playwright test ${playwrightSpecs.join(" ")}`;
        try {
          const pwOut = execSync(cmd, {
            cwd: webUiCwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: childEnv,
            timeout: pwRemainingMs,
          });
          testOutput += `\n--- Playwright Spec Stage ---\n${pwOut}`;
          const counts = parsePlaywrightReport(reportPath);
          if (counts.passed === 0 && counts.failed === 0) {
            failedCount += 1;
            runError = "Playwright test runner produced empty test results";
          } else {
            passedCount += counts.passed;
            failedCount += counts.failed;
            testOutput += `\n[Playwright Spec Stage] passed=${counts.passed} failed=${counts.failed}\n`;
          }
        } catch (err: unknown) {
          const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
          const stdout = e.stdout ? e.stdout.toString() : "";
          const stderr = e.stderr ? e.stderr.toString() : "";
          testOutput += `\n--- Playwright Spec Stage ---\n${stdout}\n${stderr}`;
          try {
            const counts = parsePlaywrightReport(reportPath);
            if (counts.passed === 0 && counts.failed === 0) {
              failedCount += 1;
            } else {
              passedCount += counts.passed;
              failedCount += counts.failed > 0 ? counts.failed : 1;
              testOutput += `\n[Playwright Spec Stage] passed=${counts.passed} failed=${counts.failed}\n`;
            }
          } catch {
            failedCount += 1;
          }
          runError = e.message ?? String(err);
        }
      }
    } finally {
      playwrightDurationMs = Date.now() - pwStart;
    }
  }

  // 2. Run mcp-server tests if mcp-server was touched
  if (mcpIncluded && fs.existsSync(mcpServerCwd) && !runError) {
    try {
      const remainingTime = Math.max(
        1,
        budgetSeconds * 1000 - (Date.now() - startTime - playwrightDurationMs)
      );
      const mcpOut = execSync("npm test", {
        cwd: mcpServerCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        timeout: remainingTime,
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
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const stdout = e.stdout ? e.stdout.toString() : "";
      const stderr = e.stderr ? e.stderr.toString() : "";
      testOutput += `\n--- MCP Server Failure ---\n${stdout}\n${stderr}`;
      const counts = parseTapCounts(stdout + "\n" + stderr);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed > 0 ? counts.failed : 1;
      }
      runError = e.message ?? String(err);
    }
  }

  // 3. Run browser-mcp tests if browser-mcp was touched
  if (browserMcpIncluded && fs.existsSync(browserMcpCwd) && !runError) {
    try {
      const remainingTime = Math.max(
        1,
        budgetSeconds * 1000 - (Date.now() - startTime - playwrightDurationMs)
      );
      const browserOut = execSync("npm test", {
        cwd: browserMcpCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        timeout: remainingTime,
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
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const stdout = e.stdout ? e.stdout.toString() : "";
      const stderr = e.stderr ? e.stderr.toString() : "";
      testOutput += `\n--- Browser MCP Failure ---\n${stdout}\n${stderr}`;
      const counts = parseTapCounts(stdout + "\n" + stderr);
      if (counts.passed === 0 && counts.failed === 0) {
        failedCount += 1;
      } else {
        passedCount += counts.passed;
        failedCount += counts.failed > 0 ? counts.failed : 1;
      }
      runError = e.message ?? String(err);
    }
  }

  const totalElapsedMs = Date.now() - startTime;
  const rawDurationSeconds = totalElapsedMs / 1000;
  const durationSeconds = parseFloat(rawDurationSeconds.toFixed(3));
  const nonPlaywrightDurationSeconds = (totalElapsedMs - playwrightDurationMs) / 1000;

  // Check budget overrun (excluding Playwright stage duration) or execution timeout
  const timedOut =
    nonPlaywrightDurationSeconds > budgetSeconds ||
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
      output: testOutput,
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
    output: testOutput,
  };
}
