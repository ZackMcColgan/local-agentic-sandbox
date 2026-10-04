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
