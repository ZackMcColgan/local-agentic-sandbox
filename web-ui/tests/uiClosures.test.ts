import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";

import { ThreadStore } from "../lib/threads/threadStore";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { formatHumanReadableTrace } from "../lib/chatUtils";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { ChatMessageItem } from "../components/chat/messageRender";
import { CanvasProvider } from "../components/CanvasContext";
import { CanvasDiffSheet } from "../components/CanvasDiffSheet";
import { BoardStore } from "../lib/board/boardStore";
import { BoardView } from "../components/BoardView";
import { BuildsView } from "../components/BuildsView";
import { ExecutionTrace } from "../components/ExecutionTrace";
import { SandboxGauge } from "../components/SandboxGauge";
import { ModelBottomSheet } from "../components/ModelBottomSheet";
import { MorningReportView } from "../components/MorningReportView";
import { SkillsView } from "../components/SkillsView";
import { GET as getSkills } from "../app/api/skills/route";
import { DELETE as deleteBoard } from "../app/api/board/route";
import type { Thread } from "../lib/threads/types";
import type { TimelineWriteDiff } from "../lib/activityTimeline";
import type { OvernightMorningReport } from "../lib/subagents/morningReport";

async function flushEffects(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("U-F8 — ThreadSummary streamingChars, host_replace_string label, persisted m.diffs in ActivityTimeline", () => {
  it("projects non-zero streamingChars on ThreadSummary and renders it in ThreadsSidebar without messages", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uf8-streaming-chars-"));
    try {
      const store = new ThreadStore(tmpDir);
      const thread = store.createThread({ title: "Live char count thread", model: "test-model" });
      thread.status = "running";
      thread.messages = [
        {
          id: "u1",
          role: "user",
          content: "Build module",
          timestamp: new Date().toISOString(),
        },
        {
          id: "a1",
          role: "assistant",
          content: "Working on implementing the module now with detailed steps.",
          status: "streaming",
          traces: [
            {
              tool: "host_read_file",
              args: { path: "src/index.ts" },
              result: "ok",
              durationMs: 12,
              timestamp: new Date().toISOString(),
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ];
      store.saveThread(thread);

      const summaries = await store.listThreadSummaries();
      const s = summaries.find((item) => item.id === thread.id);
      assert.ok(s, "ThreadSummary must exist");
      const expectedChars = thread.messages.reduce(
        (n, m) => n + (m.content ? m.content.replace(/\s/g, "").length : 0),
        0
      );
      assert.equal(
        (s as { streamingChars?: number }).streamingChars,
        expectedChars,
        "ThreadSummary must project streamingChars"
      );
      assert.ok(expectedChars > 0);

      const sidebarHtml = renderToString(
        React.createElement(ThreadsSidebar, {
          threads: [s as unknown as Thread],
          selectedThreadId: s.id,
          onSelectThread: () => {},
          onNewThread: () => {},
        })
      );
      assert.ok(
        sidebarHtml.includes(`${expectedChars} chars`),
        `ThreadsSidebar must render '${expectedChars} chars' instead of '0 chars', got: ${sidebarHtml}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("formatHumanReadableTrace formats host_replace_string as Host Edited <file>", () => {
    const res = formatHumanReadableTrace({
      tool: "host_replace_string",
      args: { path: "C:\\repo\\web-ui\\lib\\sample.ts" },
      durationMs: 18,
    });
    assert.equal(res.badge, "host");
    assert.equal(res.title, "Host Edited sample.ts");

    const fallback = formatHumanReadableTrace({
      tool: "host_replace_string",
      args: {},
      durationMs: 10,
    });
    assert.equal(fallback.title, "Host Edited File");
  });

  it("ActivityTimeline prefers persisted m.diffs with removed lines over trace-arg diffs and ChatMessageItem omits duplicate CanvasDiffCard", () => {
    let capturedDiff: TimelineWriteDiff | null = null;
    let capturedAll: TimelineWriteDiff[] = [];

    const win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const div = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      div as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(div);

    const traces = [
      {
        tool: "host_write_file",
        args: {
          path: "src/app.ts",
          content: "export const v = 2;\nexport const extra = true;",
        },
        result: { ok: true },
        durationMs: 22,
        timestamp: new Date().toISOString(),
      },
    ];
    const persistedDiffs = [
      {
        path: "src/app.ts",
        diff: "@@ -1,2 +1,2 @@\n-export const v = 1;\n-export const old = false;\n+export const v = 2;\n+export const extra = true;",
        addedLines: 2,
        removedLines: 2,
      },
    ];

    try {
      act(() => {
        root.render(
          React.createElement(
            CanvasProvider,
            null,
            React.createElement(ChatMessageItem, {
              message: {
                id: "m-diff-1",
                role: "assistant",
                content: "Updated app.ts.",
                traces,
                diffs: persistedDiffs,
                status: "completed",
              },
              idx: 0,
              copiedMessageId: null,
              lastLinkedTaskMsgIndex: -1,
              lastAssistantIndex: 0,
              liveTurnTraces: [],
              isLoading: false,
              isStoppingTask: false,
              activeAssistantMsgId: null,
              completedTurnMsgId: null,
              streamStatus: null,
              turnStartedAtMs: Date.now() - 1000,
              lastActivityAtMs: Date.now(),
              expandedTraces: {},
              expandedProofs: {},
              hasResolvedDetachedTurn: false,
              activeModel: "test-model",
              onPreviewImage: () => {},
              onCopyToClipboard: () => {},
              onRetry: () => {},
              onToggleProof: () => {},
              onToggleTraces: () => {},
              onRunControlAction: () => {},
              onOpenCanvasDiff: (diff, all) => {
                capturedDiff = diff;
                capturedAll = all;
              },
            })
          )
        );
      });

      // Duplicate CanvasDiffCard below ActivityTimeline must be retired
      assert.equal(
        Boolean(div.querySelector('[data-testid="canvas-diff-open"]')),
        false,
        "Duplicate CanvasDiffCard must not render below ActivityTimeline"
      );

      // Open from ActivityTimeline must pass the persisted pre-image diff with removed lines
      const openBtn = div.querySelector('[data-testid="open-in-canvas-btn"]') as HTMLElement | null;
      assert.ok(openBtn, "ActivityTimeline must render Open button");
      act(() => {
        openBtn.click();
      });

      assert.ok(capturedDiff, "onOpenCanvasDiff must receive a diff");
      assert.equal(
        (capturedDiff as TimelineWriteDiff).removedLines,
        2,
        "Opened diff must preserve pre-image removedLines from m.diffs"
      );
      assert.ok(
        (capturedDiff as TimelineWriteDiff).diffText?.includes("-export const v = 1;"),
        "Opened diff must contain pre-image removed lines from m.diffs"
      );
      assert.equal(capturedAll.length, 1);

      const sheetHtml = renderToString(
        React.createElement(CanvasDiffSheet, {
          currentDiff: capturedDiff!,
          allDiffs: capturedAll,
          onSelectDiff: () => {},
          onClose: () => {},
        })
      );
      assert.ok(sheetHtml.includes("-export const v = 1;"));
    } finally {
      act(() => root.unmount());
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      win.close();
    }
  });
});

describe("U-F9 — Board DELETE/edit, settled Thread links, rose needs-attention, SchedulesPanel, BuildsView honesty", () => {
  it("BoardStore.remove and DELETE /api/board remove an item", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uf9-board-delete-"));
    const prevBoardDir = process.env.BOARD_DIR;
    process.env.BOARD_DIR = tmpDir;
    try {
      const store = new BoardStore(tmpDir);
      const item = store.create({
        key: "#77",
        title: "removable-item",
        brief: "Test deletion",
        dependencies: [],
        author: "Owner",
        source: "manual",
      });

      const res = await deleteBoard(
        new NextRequest(`http://localhost/api/board?id=${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        })
      );
      assert.equal(res.status, 200);
      const reloaded = new BoardStore(tmpDir);
      assert.equal(reloaded.get(item.id), undefined, "Deleted item must not remain on disk");
    } finally {
      if (prevBoardDir === undefined) delete process.env.BOARD_DIR;
      else process.env.BOARD_DIR = prevBoardDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("BoardView shows Thread and Brief on settled (done / needs-attention) cards, styles needs-attention in rose, and exposes edit/delete controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(BoardView, {
        items: [
          {
            id: "item-done",
            key: "#201",
            title: "settled-done-card",
            brief: "Finished cleanly.",
            dependencies: [],
            status: "done",
            author: "Owner",
            source: "manual",
            threadLink: "/?thread=thread-done-201",
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: "2026-11-23T00:00:00Z",
          },
          {
            id: "item-attn",
            key: "#202",
            title: "settled-attention-card",
            brief: "Blocked on review.",
            dependencies: [],
            status: "needs-attention",
            needsAttention: true,
            parkedReason: "Worker failed verification twice",
            author: "Owner",
            source: "manual",
            threadLink: "/?thread=thread-attn-202",
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: "2026-11-23T00:00:00Z",
          },
        ],
        onOpenDrawer: () => {},
        onItemCreated: () => {},
        onAskAssistant: () => {},
      })
    );

    assert.ok(html.includes("/?thread=thread-done-201"), "Done card must show Thread link");
    assert.ok(
      html.includes("/?thread=thread-attn-202"),
      "Needs-attention card must show Thread link"
    );
    assert.ok(
      html.includes("border-rose-") && html.includes("text-rose-"),
      "needs-attention badge/reason must be styled in rose"
    );
    assert.ok(
      !html.includes(
        'border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-300">needs attention'
      ),
      "needs-attention badge must not be emerald"
    );
    assert.ok(
      html.includes('data-testid="board-edit-item-done"'),
      "Edit button must exist on cards"
    );
    assert.ok(
      html.includes('data-testid="board-delete-item-done"'),
      "Delete button must exist on cards"
    );
  });

  it("SchedulesPanel lists schedules and triggers runs via /api/schedules", async () => {
    const mod = await import("../components/SchedulesPanel");
    const SchedulesPanel = mod.SchedulesPanel;
    assert.ok(SchedulesPanel, "SchedulesPanel must be exported");

    const win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(container);

    const calls: Array<{ url: string; method: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method || "GET";
      calls.push({ url: u, method });
      if (u.includes("/api/scheduler/health")) {
        return new Response(
          JSON.stringify({
            status: "healthy",
            daemon: { active: true, pid: 42, lastTick: new Date().toISOString(), stale: false },
            scheduler: null,
            schedules: { total: 1, enabled: 1, nextRun: "2026-11-25T02:00:00.000Z" },
          }),
          { status: 200 }
        );
      }
      if (u.includes("/trigger")) {
        return new Response(JSON.stringify({ runId: "task-trig-1", status: "active" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          schedules: [
            {
              id: "sched-nightly",
              cronExpression: "0 2 * * *",
              taskDescription: "Run nightly security audit",
              enabled: true,
              createdAt: "2026-11-20T00:00:00.000Z",
              nextRun: "2026-11-25T02:00:00.000Z",
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    try {
      await act(async () => {
        root.render(React.createElement(SchedulesPanel));
      });
      await flushEffects();

      assert.ok(
        container.textContent?.includes("Run nightly security audit"),
        "SchedulesPanel must list schedule descriptions"
      );
      assert.ok(
        container.textContent?.includes("0 2 * * *"),
        "SchedulesPanel must show cron expression"
      );

      const triggerBtn = container.querySelector(
        '[data-testid="schedule-trigger-sched-nightly"]'
      ) as HTMLButtonElement | null;
      assert.ok(triggerBtn, "SchedulesPanel must render a trigger button for each schedule");
      await act(async () => {
        triggerBtn.click();
      });
      await flushEffects();

      assert.ok(
        calls.some(
          (c) => c.url.includes("/api/schedules/sched-nightly/trigger") && c.method === "POST"
        ),
        "Trigger click must POST /api/schedules/sched-nightly/trigger"
      );
    } finally {
      act(() => root.unmount());
      globalThis.fetch = origFetch;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      win.close();
    }
  });

  it("BuildsView removes dead Rollback button and preserves threadLink & real branch on board fallback", async () => {
    const win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(container);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/board")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "item-b1",
                title: "Board Fallback Job",
                status: "working",
                threadLink: "/?thread=thread-b1",
                handoff: {
                  branch: "feat/real-branch-b1",
                  state: "working",
                  headSha: "abc",
                  nextStep: "test",
                },
                createdAt: "2026-11-23T00:00:00.000Z",
                updatedAt: "2026-11-23T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(BuildsView, {
            onOpenDrawer: () => {},
            activeTask: null,
            onSelectThread: () => {},
          })
        );
      });
      await flushEffects();

      assert.equal(
        container.textContent?.includes("Rollback (Previous)"),
        false,
        "Permanently disabled Rollback button must be removed"
      );
      assert.ok(
        container.textContent?.includes("feat/real-branch-b1"),
        "BuildsView board fallback must preserve real branch name"
      );
      assert.equal(
        container.textContent?.includes("main"),
        false,
        "BuildsView board fallback must not hardcode 'main'"
      );
      assert.ok(
        container.textContent?.includes("Open Thread"),
        "BuildsView board fallback must preserve threadLink as Open Thread button"
      );
    } finally {
      act(() => root.unmount());
      globalThis.fetch = origFetch;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      win.close();
    }
  });
});

describe("U-F10 — Honest host badges, live engine/sandbox telemetry, Morning Report API wiring & empty state, real SKILL.md", () => {
  it("ExecutionTrace with tier='host' and SandboxGauge with hostAccess never render Air-Gapped / UID 10001 / Read-Only", () => {
    const traceHtml = renderToString(
      React.createElement(ExecutionTrace, {
        hostAccess: true,
        traces: [
          {
            tool: "host_run_powershell",
            args: { command: "git status" },
            result: "clean",
            durationMs: 25,
            timestamp: "2026-11-23T00:00:00.000Z",
            tier: "host",
          },
        ],
      })
    );
    assert.ok(
      traceHtml.includes("Host Execution") || traceHtml.includes("Host Bridge"),
      "Host trace must display a Host Execution / Host Bridge badge"
    );
    assert.equal(traceHtml.includes("Air-Gapped"), false, "Host trace must never say Air-Gapped");
    assert.equal(traceHtml.includes("UID: 10001"), false, "Host trace must never say UID: 10001");
    assert.equal(
      traceHtml.includes("RootFS: READ_ONLY"),
      false,
      "Host trace must never say RootFS: READ_ONLY"
    );

    const gaugeHtml = renderToString(React.createElement(SandboxGauge, { hostAccess: true }));
    assert.ok(
      gaugeHtml.includes("Host Bridge") || gaugeHtml.includes("Host Execution"),
      "SandboxGauge with hostAccess must indicate Host Bridge"
    );
    assert.equal(
      gaugeHtml.includes("air-gapped"),
      false,
      "Host SandboxGauge must not say air-gapped"
    );
    assert.equal(
      gaugeHtml.includes("Read-Only Enforced"),
      false,
      "Host SandboxGauge must not say Read-Only Enforced"
    );
  });

  it("ModelBottomSheet and BuildsView do not render fabricated static '16 GB VRAM' or 'Build Tier Ready'", () => {
    const sheetHtml = renderToString(
      React.createElement(ModelBottomSheet, {
        isOpen: true,
        onClose: () => {},
        selectedModel: "qwen3.8-flash-next-gyro-gyro-s",
        onModelChange: () => {},
        reasoningEffort: "low",
      })
    );
    assert.equal(
      sheetHtml.includes("16 GB VRAM"),
      false,
      "ModelBottomSheet must not fabricate 16 GB VRAM"
    );

    const buildsHtml = renderToString(
      React.createElement(BuildsView, {
        onOpenDrawer: () => {},
        activeTask: null,
        tasks: [],
        onSelectThread: () => {},
      })
    );
    assert.equal(
      buildsHtml.includes("Build Tier Ready"),
      false,
      "BuildsView must not fabricate 'Build Tier Ready' when sandbox status is unknown"
    );
  });

  it("MorningReportView awaits POST /api/tasks res.ok before marking Reviewed and renders honest empty state for empty windows", async () => {
    const win = new GlobalWindow({ url: "http://localhost:3000" });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    const container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    const root = createRoot(container);

    // Task timestamped 10 days ago so Overnight & 24h windows have 0 tasks
    const oldDate = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const reportData: OvernightMorningReport = {
      reportId: "rep-uf10",
      generatedAt: oldDate,
      windowLabel: "Autonomous Run",
      totalTasks: 1,
      completedCount: 1,
      parkedCount: 0,
      failedCount: 0,
      totalDurationSeconds: 60,
      totalDurationFormatted: "1m 0s",
      tasks: [
        {
          taskId: "task-old-1",
          goal: "Old task outside 24h",
          status: "completed",
          branch: "feat/old",
          gitHeadSha: "1111111",
          startedAt: oldDate,
          durationSeconds: 60,
          durationFormatted: "1m 0s",
          artifacts: [],
          milestones: [],
          ambiguityFlags: [
            {
              id: "AMB-10",
              milestoneId: "M1",
              question: "Keep old API shape?",
              judgmentCall: "Kept compatibility wrapper",
              reasoning: "Avoid breaking callers",
              revertAction: { type: "git_revert", target: "abc" },
              reviewed: false,
            },
          ],
          testsPassed: 3,
          testsFailed: 0,
        },
      ],
      artifactsProduced: [],
      attentionItems: [],
      summaryMarkdown: "",
    };

    const singleReport = {
      taskId: "task-old-1",
      goal: "Old task outside 24h",
      branch: "feat/old",
      gitHeadSha: "1111111",
      status: "completed" as const,
      startedAt: oldDate,
      milestones: [],
      ambiguityFlags: reportData.tasks[0].ambiguityFlags,
      parkedItems: [],
      totalTestsPassed: 3,
      totalTestsFailed: 0,
      durationFormatted: "1m 0s",
      summaryMarkdown: "",
    };

    const origFetch = globalThis.fetch;
    let revertShouldFail = true;
    const postBodies: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) {
        postBodies.push(JSON.parse(String(init.body)));
      }
      if (revertShouldFail) {
        return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(MorningReportView, {
            overnightReport: reportData,
            report: singleReport,
          })
        );
      });
      await flushEffects();

      // Switch to Last 24h (which has 0 tasks) -> must show honest empty state, NOT fallback to old task
      const btn24h = container.querySelector('[data-testid="filter-24h"]') as HTMLButtonElement;
      assert.ok(btn24h);
      await act(async () => {
        btn24h.click();
      });
      await flushEffects();
      assert.ok(
        container.textContent?.includes("No tasks have executed in this window yet"),
        "Empty 24h window must show honest empty state instead of falling back to uniqueTasks"
      );

      // Failed POST /api/tasks must NOT mark flag Reviewed
      const revertBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Revert")
      );
      assert.ok(revertBtn, "Revert button must render");
      await act(async () => {
        revertBtn.click();
      });
      await flushEffects();
      assert.equal(postBodies.length, 1, "Clicking Revert must POST /api/tasks");
      assert.equal(
        container.textContent?.includes("✓ Reviewed"),
        false,
        "Flag must NOT be marked Reviewed when POST /api/tasks fails"
      );

      // Succeeding POST /api/tasks marks flag Reviewed
      revertShouldFail = false;
      await act(async () => {
        revertBtn.click();
      });
      await flushEffects();
      assert.ok(
        container.textContent?.includes("✓ Reviewed"),
        "Flag must be marked Reviewed after POST /api/tasks returns ok"
      );
    } finally {
      act(() => root.unmount());
      globalThis.fetch = origFetch;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
      win.close();
    }
  });

  it("/api/skills reads real SKILL.md from disk and SkillsView renders server markdown without hardcoded confidence: 0.94", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uf10-skills-md-"));
    const prevSkillsDir = process.env.SKILLS_DIR;
    process.env.SKILLS_DIR = tmpDir;
    try {
      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });
      const realMarkdown = `---
id: real-disk-skill
status: pending
pattern: clean-imports
occurrences: 5
---

## Directive
Use explicit relative imports from \`@/lib\`.
`;
      fs.writeFileSync(path.join(pendingDir, "real-disk-skill.md"), realMarkdown, "utf8");
      fs.writeFileSync(
        path.join(tmpDir, "pending.json"),
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          candidates: {
            "real-disk-skill": {
              id: "real-disk-skill",
              title: "Clean Imports",
              pattern: "clean-imports",
              occurrences: 5,
              firstObserved: new Date().toISOString(),
              lastObserved: new Date().toISOString(),
              solutionSummary: "Use explicit relative imports.",
              status: "pending",
            },
          },
        }),
        "utf8"
      );

      const res = await getSkills(new NextRequest("http://localhost/api/skills"));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.pendingCandidates.length, 1);
      assert.equal(
        data.pendingCandidates[0].skillMd,
        realMarkdown,
        "GET /api/skills must return real candidate SKILL.md markdown from disk"
      );

      const html = renderToString(
        React.createElement(SkillsView, {
          onOpenDrawer: () => {},
          initialPending: data.pendingCandidates,
          initialPreviewCandidate: data.pendingCandidates[0],
        })
      );
      assert.ok(
        html.includes("Use explicit relative imports from"),
        "SkillsView must render server-returned SKILL.md markdown"
      );
      assert.equal(
        html.includes("confidence: 0.94"),
        false,
        "SkillsView must never render hardcoded confidence: 0.94"
      );
    } finally {
      if (prevSkillsDir === undefined) delete process.env.SKILLS_DIR;
      else process.env.SKILLS_DIR = prevSkillsDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
