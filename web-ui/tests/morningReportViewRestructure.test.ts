import { describe, it } from "node:test";
import assert from "node:assert/strict";

// uir-4 — Morning Report restructure:
// 1. Verdict banner first + sticky, state-driven color, real counts only.
// 2. Attention cards (incl. owner flags) render above the artifacts section.
// 3. Task list capped with an expand control.
// 4. "Parked" wording replaced by "Stalled" in the rendered view.

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    taskId: "task-001",
    goal: "Generic overnight task",
    branchName: "feature/overnight",
    toolchain: "node:22",
    status: "completed",
    startedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date().toISOString(),
    currentMilestoneIndex: 1,
    milestones: [],
    checkpoints: [],
    ambiguityFlags: [],
    journal: [],
    ...overrides
  };
}

function mixedTasks(): any[] {
  return [
    makeTask({
      taskId: "task-artifact",
      goal: "Produce the summary document",
      milestones: [
        {
          id: "M1",
          title: "Write document",
          description: "Artifact generation",
          status: "completed",
          plannedFiles: ["docs/single-output.md"]
        }
      ]
    }),
    makeTask({ taskId: "task-done-2", goal: "Second completed task" }),
    makeTask({ taskId: "task-done-3", goal: "Third completed task" }),
    makeTask({ taskId: "task-done-4", goal: "Fourth completed task" }),
    makeTask({ taskId: "task-done-5", goal: "Fifth completed task" }),
    makeTask({
      taskId: "task-stalled-1",
      goal: "Schema change run",
      status: "parked",
      parkedReason: "Waiting on manual review of the produced diff."
    }),
    makeTask({
      taskId: "task-stalled-2",
      goal: "Config migration run",
      status: "parked",
      parkedReason: "Waiting on a decision about the schema change."
    }),
    makeTask({
      taskId: "task-failed-1",
      goal: "Verification run",
      status: "failed",
      errorSummary: "Verification step exited non-zero."
    })
  ];
}

const sampleFlag: any = {
  id: "AMB-1",
  milestoneId: "M1",
  question: "Should the summary document default to a white background?",
  judgmentCall: "Selected a white background per the standing light-mode rule.",
  reasoning: "Light Mode Purity specifies white backgrounds for documents.",
  revertAction: { type: "git_revert", target: "bca5b34" },
  reviewed: false
};

async function renderView(overnightReport: any, report?: any): Promise<string> {
  const React = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { MorningReportView } = await import("../components/MorningReportView.js");
  return renderToString(
    React.createElement(MorningReportView, {
      overnightReport,
      report: report ?? null
    })
  );
}

async function buildMixedRender() {
  const { generateOvernightMorningReport, generateMorningReport } = await import(
    "../lib/subagents/morningReport.js"
  );
  const overnightReport = generateOvernightMorningReport(mixedTasks());
  const singleReport = generateMorningReport({
    taskId: "task-artifact",
    goal: "Produce the summary document",
    branch: "feature/overnight",
    gitHeadSha: "abc1234",
    status: "completed",
    startedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date().toISOString(),
    milestones: [],
    ambiguityFlags: [sampleFlag],
    parkedItems: []
  });
  return renderView(overnightReport, singleReport);
}

describe("uir-4 — Morning Report verdict banner", () => {
  it("renders first, sticky, failure-toned, with counts from the real report data", async () => {
    const html = await buildMixedRender();
    const { Window } = await import("happy-dom");
    const window = new Window();
    window.document.body.innerHTML = html;

    const banner = window.document.querySelector('[data-testid="verdict-banner"]');
    assert.ok(banner, "verdict banner must render");
    assert.ok(
      banner.className.includes("sticky"),
      "verdict banner must be sticky so it stays at the top while scrolling"
    );
    assert.equal(
      banner.getAttribute("data-verdict"),
      "failed",
      "a night with failures must produce the failure verdict state"
    );
    const text = banner.textContent || "";
    assert.ok(text.includes("5/8 tasks completed"), `verdict must carry the real completion count, got: ${text}`);
    assert.ok(text.includes("1 failed"), `verdict must carry the real failed count, got: ${text}`);
    assert.ok(text.includes("2 stalled"), `verdict must carry the real stalled count, got: ${text}`);
    assert.ok(
      text.includes("1 flag needs a decision"),
      `verdict must carry the real unreviewed flag count, got: ${text}`
    );

    const bannerIdx = html.indexOf('data-testid="verdict-banner"');
    const summaryIdx = html.indexOf("Overnight Autonomous Summary");
    assert.ok(summaryIdx > -1, "summary heading must still render");
    assert.ok(bannerIdx < summaryIdx, "verdict banner must render before the summary card");
  });

  it("renders the calm all-clear verdict when everything completed and no flags wait", async () => {
    const { generateOvernightMorningReport } = await import("../lib/subagents/morningReport.js");
    const overnightReport = generateOvernightMorningReport([
      makeTask({ taskId: "task-clear-1" }),
      makeTask({ taskId: "task-clear-2" }),
      makeTask({ taskId: "task-clear-3" })
    ]);
    const html = await renderView(overnightReport);
    const { Window } = await import("happy-dom");
    const window = new Window();
    window.document.body.innerHTML = html;

    const banner = window.document.querySelector('[data-testid="verdict-banner"]');
    assert.ok(banner, "verdict banner must render");
    assert.equal(banner.getAttribute("data-verdict"), "clear");
    const text = banner.textContent || "";
    assert.ok(text.includes("3/3 tasks completed"), `verdict must carry the real count, got: ${text}`);
    assert.ok(text.includes("All clear"), `clear verdict must say so, got: ${text}`);
  });
});

describe("uir-4 — Morning Report section order", () => {
  it("renders attention cards and owner flags above the produced artifacts", async () => {
    const html = await buildMixedRender();
    const attentionIdx = html.indexOf("What Needs Attention");
    const flagsIdx = html.indexOf("Ambiguity Flags");
    const producedIdx = html.indexOf("What Was Produced");
    const ranIdx = html.indexOf("What Ran");

    assert.ok(attentionIdx > -1, "attention section must render");
    assert.ok(flagsIdx > -1, "flags section must render");
    assert.ok(producedIdx > -1, "produced section must render");
    assert.ok(ranIdx > -1, "task log section must render");
    assert.ok(attentionIdx < producedIdx, "attention cards must render above artifacts");
    assert.ok(flagsIdx < producedIdx, "owner flags must render above artifacts");
    assert.ok(producedIdx < ranIdx, "artifacts must render above the full task list");
  });
});

describe("uir-4 — Morning Report task list cap", () => {
  it("caps the task list at 5 rows with a show-all control naming the real total", async () => {
    const html = await buildMixedRender();
    const { Window } = await import("happy-dom");
    const window = new Window();
    window.document.body.innerHTML = html;

    const rows = window.document.querySelectorAll('[data-testid="task-row"]');
    assert.equal(rows.length, 5, `task list must be capped at 5 rows, got ${rows.length}`);

    const toggle = window.document.querySelector('[data-testid="task-list-toggle"]');
    assert.ok(toggle, "an expand control must render when the list is capped");
    assert.ok(
      (toggle.textContent || "").includes("Show all 8 tasks"),
      `expand control must name the real total, got: ${toggle.textContent}`
    );
  });
});

describe("uir-4 — Morning Report stalled wording", () => {
  it("renders Stalled everywhere the legacy wording appeared", async () => {
    const html = await buildMixedRender();
    assert.doesNotMatch(
      html,
      /parked/i,
      "rendered view must not contain the legacy parked wording"
    );
    assert.ok(html.includes(">Stalled<"), "the KPI tile must be labelled Stalled");
    assert.ok(html.includes(">stalled<"), "status pills for stalled tasks must read stalled");
  });
});
