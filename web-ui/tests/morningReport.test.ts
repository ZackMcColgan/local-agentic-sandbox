import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateMorningReport,
  formatMorningReportMarkdown,
  MorningReportInput
} from "../lib/subagents/morningReport.js";

describe("Phase 1 — Morning Report Suite", () => {
  const sampleInput: MorningReportInput = {
    taskId: "task-overnight-001",
    goal: "Build a draw.io architecture diagram of this repo's current state, README-ready",
    branch: "feat/v2.5-overnight",
    gitHeadSha: "bca5b34a1",
    status: "completed",
    startedAt: "2026-10-02T03:00:00Z",
    completedAt: "2026-10-02T05:30:00Z",
    milestones: [
      {
        id: "M1",
        title: "Inventory Platform Topology & Container Boundaries",
        status: "completed",
        commitSha: "a1b2c3d",
        testsPassed: 4,
        testsFailed: 0,
        diffSummary: "Cataloged 5 services, 2 networks, 3 volumes"
      },
      {
        id: "M2",
        title: "Generate Valid Draw.io XML Architecture Diagram",
        status: "completed",
        commitSha: "bca5b34",
        testsPassed: 6,
        testsFailed: 0,
        diffSummary: "Created docs/architecture.drawio.svg (valid XML, light theme)"
      },
      {
        id: "M3",
        title: "Critic Evaluation & Verification",
        status: "completed",
        commitSha: "d4e5f6a",
        testsPassed: 8,
        testsFailed: 0,
        diffSummary: "Verified against acceptance criteria AC-1-1 and AC-2-1"
      }
    ],
    ambiguityFlags: [
      {
        id: "AMB-1",
        milestoneId: "M2",
        question: "Should the draw.io architecture diagram default to white background or dark canvas?",
        judgmentCall: "Selected crisp white (#ffffff) background per Zack's standing UI & visual inspection rule.",
        reasoning: "Rule 2.A specifies Light Mode Purity / white background for diagrams linked to root README.",
        revertAction: {
          type: "git_revert",
          target: "bca5b34"
        },
        reviewed: false
      }
    ],
    parkedItems: []
  };

  it("generates structured Morning Report with milestones, commits, and ambiguity flags", () => {
    const report = generateMorningReport(sampleInput);

    assert.equal(report.taskId, "task-overnight-001");
    assert.equal(report.status, "completed");
    assert.equal(report.milestones.length, 3);
    assert.equal(report.ambiguityFlags.length, 1);
    assert.equal(report.ambiguityFlags[0].judgmentCall.includes("white (#ffffff) background"), true);
    assert.equal(report.totalTestsPassed, 18);
    assert.equal(report.totalTestsFailed, 0);
  });

  it("formats hiring-manager grade markdown with commit links and one-tap revert actions", () => {
    const report = generateMorningReport(sampleInput);
    const md = formatMorningReportMarkdown(report);

    assert.ok(md.includes("# Autonomous Morning Report: task-overnight-001"));
    assert.ok(md.includes("Branch: `feat/v2.5-overnight`"));
    assert.ok(md.includes("bca5b34a1"));
    assert.ok(md.includes("M1: Inventory Platform Topology & Container Boundaries"));
    assert.ok(md.includes("Ambiguity Flags & Judgment Calls (1)"));
    assert.ok(md.includes("**Revert Action**: `git_revert bca5b34`"));
  });

  it("includes parked items prominently when supervisor parks an unresolved milestone", () => {
    const parkedInput: MorningReportInput = {
      ...sampleInput,
      status: "parked",
      parkedItems: ["Milestone M2 stalled after 20 minutes without forward progress. State snapshotted."]
    };

    const report = generateMorningReport(parkedInput);
    const md = formatMorningReportMarkdown(report);

    assert.equal(report.status, "parked");
    assert.ok(md.includes("⚠️ **Status: PARKED (Requires Zack's Review)**"));
    assert.ok(md.includes("Milestone M2 stalled after 20 minutes"));
  });

  it("includes Phase C Test Verification Tiers in morning report markdown", () => {
    const tieredInput: MorningReportInput = {
      ...sampleInput,
      testTiers: [
        {
          name: "Tier 1: Change-Aware Gate",
          command: "npm run test:gate",
          status: "passed",
          durationSeconds: 4.2,
          budgetSeconds: 90,
          testsPassed: 45,
          testsFailed: 0,
          details: "Zero-coverage check verified across 12 modified files"
        },
        {
          name: "Tier 2: Full Regression Suite",
          command: "npm test",
          status: "passed",
          durationSeconds: 11.8,
          testsPassed: 123,
          testsFailed: 0,
          details: "All 21 web-ui suites and 9 mcp-server suites green"
        }
      ]
    };

    const report = generateMorningReport(tieredInput);
    const md = formatMorningReportMarkdown(report);

    assert.ok(md.includes("## 2. Test Verification Tiers (Phase C)"), "Contains Test Verification Tiers heading");
    assert.ok(md.includes("Tier 1: Change-Aware Gate"), "Contains Tier 1 name");
    assert.ok(md.includes("`npm run test:gate`"), "Contains Tier 1 command");
    assert.ok(md.includes("Tier 2: Full Regression Suite"), "Contains Tier 2 name");
    assert.ok(md.includes("<90s"), "Contains budget constraint");
    assert.ok(md.includes("All 21 web-ui suites and 9 mcp-server suites green"), "Contains details");
  });
});

describe("Sprint 12 Phase 2 — Overnight Morning Report Loop (Multi-Task Window)", () => {
  it("generates an overnight report from a mix of completed, parked, and failed tasks", async () => {
    const mod = await import("../lib/subagents/morningReport.js") as any;
    assert.equal(typeof mod.generateOvernightMorningReport, "function", "generateOvernightMorningReport must be exported");

    const tasks = [
      {
        taskId: "task-101-completed",
        threadId: "thread-101",
        goal: "Create a markdown checklist for a weekend camping trip",
        branchName: "feature/camping-checklist",
        toolchain: "node:22",
        status: "completed",
        startedAt: "2026-10-13T23:15:00.000Z",
        completedAt: "2026-10-13T23:18:30.000Z",
        updatedAt: "2026-10-13T23:18:30.000Z",
        currentMilestoneIndex: 1,
        milestones: [
          {
            id: "M1",
            title: "Generate camping-checklist.md",
            description: "Create markdown checklist",
            acceptanceCriteria: [],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1,
            plannedFiles: ["docs/camping-checklist.md"],
            diffSummary: "File: docs/camping-checklist.md\n+# Weekend Camping Checklist\n- [ ] Tent",
            testsPassed: 5,
            testsFailed: 0
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [
          {
            timestamp: "2026-10-13T23:18:00.000Z",
            role: "builder",
            message: "Generated deliverable docs/camping-checklist.md (420 bytes)."
          }
        ]
      },
      {
        taskId: "task-102-parked",
        threadId: "thread-102",
        goal: "Refactor OAuth2 token exchange with external provider",
        branchName: "feature/oauth2-refactor",
        toolchain: "node:22",
        status: "parked",
        parkedReason: "Milestone M2 stalled waiting for external OAuth client secret configuration",
        startedAt: "2026-10-14T01:10:00.000Z",
        updatedAt: "2026-10-14T01:35:00.000Z",
        currentMilestoneIndex: 1,
        milestones: [
          {
            id: "M1",
            title: "Scaffold token client",
            description: "Token client types",
            acceptanceCriteria: [],
            status: "completed",
            builderIterations: 1,
            criticRounds: 1,
            plannedFiles: ["src/auth/tokenClient.ts"],
            testsPassed: 3,
            testsFailed: 0
          },
          {
            id: "M2",
            title: "Verify live OAuth handshake",
            description: "Live handshake",
            acceptanceCriteria: [],
            status: "failed",
            builderIterations: 3,
            criticRounds: 1,
            testsPassed: 0,
            testsFailed: 2
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: []
      },
      {
        taskId: "task-103-failed",
        threadId: "thread-103",
        goal: "Compile legacy WebAssembly crypto module",
        branchName: "feature/wasm-crypto",
        toolchain: "rust",
        status: "failed",
        errorSummary: "SyntaxError: wasm-pack target binary missing in air-gapped container",
        startedAt: "2026-10-14T03:00:00.000Z",
        completedAt: "2026-10-14T03:04:15.000Z",
        updatedAt: "2026-10-14T03:04:15.000Z",
        currentMilestoneIndex: 0,
        milestones: [
          {
            id: "M1",
            title: "Build WASM module",
            description: "Compile rust to wasm",
            acceptanceCriteria: [],
            status: "failed",
            builderIterations: 3,
            criticRounds: 0,
            criticCritique: "SyntaxError: wasm-pack target binary missing in air-gapped container",
            testsPassed: 0,
            testsFailed: 1
          }
        ],
        checkpoints: [],
        ambiguityFlags: [],
        journal: [
          {
            timestamp: "2026-10-14T03:04:10.000Z",
            role: "supervisor",
            message: "Worker crash detected in milestone M1: SyntaxError: wasm-pack target binary missing"
          }
        ]
      }
    ];

    const report = mod.generateOvernightMorningReport(tasks);

    assert.equal(report.totalTasks, 3, "Should include all 3 tasks from the overnight window");
    assert.equal(report.completedCount, 1);
    assert.equal(report.parkedCount, 1);
    assert.equal(report.failedCount, 1);

    // Check task entries have status, duration, artifacts with preview links, and park/failure reasons
    const completedEntry = report.tasks.find((t: any) => t.taskId === "task-101-completed");
    assert.ok(completedEntry);
    assert.equal(completedEntry.status, "completed");
    assert.equal(completedEntry.durationFormatted, "3m 30s");
    assert.ok(completedEntry.artifacts.length >= 1, "Completed task should list produced artifacts");
    assert.ok(
      completedEntry.artifacts[0].previewUrl.includes("/api/files?path=") &&
      completedEntry.artifacts[0].previewUrl.includes("camping-checklist.md"),
      "Artifact must include a working preview link"
    );

    const parkedEntry = report.tasks.find((t: any) => t.taskId === "task-102-parked");
    assert.ok(parkedEntry);
    assert.equal(parkedEntry.status, "parked");
    assert.equal(parkedEntry.durationFormatted, "25m 0s");
    assert.ok(parkedEntry.parkedReason.includes("OAuth client secret"));

    const failedEntry = report.tasks.find((t: any) => t.taskId === "task-103-failed");
    assert.ok(failedEntry);
    assert.equal(failedEntry.status, "failed");
    assert.equal(failedEntry.durationFormatted, "4m 15s");
    assert.ok(failedEntry.errorSummary.includes("wasm-pack target binary missing"));

    // What needs attention section must include both parked and failed tasks
    assert.equal(report.attentionItems.length, 2);
    assert.ok(report.attentionItems.some((item: any) => item.taskId === "task-102-parked" && item.status === "parked"));
    assert.ok(report.attentionItems.some((item: any) => item.taskId === "task-103-failed" && item.status === "failed"));
  });

  it("persists and reloads the overnight morning report to disk so it is readable at 7am without log diving", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    const mod = await import("../lib/subagents/morningReport.js") as any;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "morning-report-test-"));
    try {
      const report = mod.generateOvernightMorningReport([
        {
          taskId: "task-persist-1",
          goal: "Generate SVG badge",
          branchName: "feature/svg-badge",
          toolchain: "node:22",
          status: "completed",
          startedAt: "2026-10-14T02:00:00.000Z",
          completedAt: "2026-10-14T02:01:15.000Z",
          updatedAt: "2026-10-14T02:01:15.000Z",
          currentMilestoneIndex: 1,
          milestones: [
            {
              id: "M1",
              title: "Create badge.svg",
              description: "Create SVG",
              acceptanceCriteria: [],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              plannedFiles: ["badge.svg"]
            }
          ],
          checkpoints: [],
          ambiguityFlags: [],
          journal: []
        }
      ]);

      mod.persistOvernightMorningReport(report, tmpDir);
      const loaded = mod.loadPersistedOvernightMorningReport(tmpDir);
      assert.ok(loaded, "Persisted report must load from disk");
      assert.equal(loaded.totalTasks, 1);
      assert.equal(loaded.tasks[0].taskId, "task-persist-1");
      assert.equal(loaded.tasks[0].durationFormatted, "1m 15s");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes /morning-report page route and /api/morning-report API endpoint", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pagePath = path.resolve(__dirname, "../app/morning-report/page.tsx");
    const apiPath = path.resolve(__dirname, "../app/api/morning-report/route.ts");
    assert.ok(fs.existsSync(pagePath), "/morning-report standalone Next.js page must exist");
    assert.ok(fs.existsSync(apiPath), "/api/morning-report API route must exist");
  });
});

