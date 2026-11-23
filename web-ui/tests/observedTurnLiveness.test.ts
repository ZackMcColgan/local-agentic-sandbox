import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ChatStream, type ChatMessage } from "../components/ChatStream";
import { NowLineBar } from "../components/NowLineBar";
import { NavigationDrawer } from "../components/NavigationDrawer";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { deriveNowLineState } from "../lib/turnSpeed";
import { deriveEffectiveLastActivityMs } from "../lib/liveActivity";
import { ThreadStore } from "../lib/threads/threadStore";
import type { Thread } from "../lib/threads/types";

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

describe("Fix 1 & Fix 4 — Observed turn liveness, auto-follow, summary parity, honest labels", () => {
  it("(a) observed (polled) turn whose updatedAt advances is never stall-stamped, and a genuinely silent one is", () => {
    const t0 = Date.parse("2026-11-22T12:00:00.000Z");
    const staleLocalMountMs = t0;

    // Poll 1 at t0 + 50s: thread.updatedAt advanced to t0 + 46s (4s ago -> live, NOT stalled)
    const poll1Now = t0 + 50_000;
    const poll1LastActivity = deriveEffectiveLastActivityMs({
      isLocalStreaming: false,
      localLastActivityAtMs: staleLocalMountMs,
      threadUpdatedAt: new Date(t0 + 46_000).toISOString(),
    });
    const poll1State = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      startedAtMs: t0,
      lastActivityAtMs: poll1LastActivity,
      nowMs: poll1Now,
    });
    assert.equal(poll1State.stallLabel, null, "Advancing updatedAt must never stall-stamp");

    // Poll 2 at t0 + 120s: thread.updatedAt advanced again to t0 + 115s (5s ago -> live)
    const poll2Now = t0 + 120_000;
    const poll2LastActivity = deriveEffectiveLastActivityMs({
      isLocalStreaming: false,
      localLastActivityAtMs: staleLocalMountMs,
      threadUpdatedAt: new Date(t0 + 115_000).toISOString(),
    });
    const poll2State = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      startedAtMs: t0,
      lastActivityAtMs: poll2LastActivity,
      nowMs: poll2Now,
    });
    assert.equal(poll2State.stallLabel, null, "Continued updatedAt advances keep turn live");

    // Genuinely silent observed turn: updatedAt stuck at t0 + 115s while nowMs is t0 + 180s (65s silent)
    const silentNow = t0 + 180_000;
    const silentState = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: true,
      startedAtMs: t0,
      lastActivityAtMs: poll2LastActivity,
      nowMs: silentNow,
    });
    assert.ok(
      silentState.stallLabel && silentState.stallLabel.includes("Stalled"),
      `Genuinely silent observed turn must be stall-stamped, got: ${silentState.stallLabel}`
    );
  });

  it("Fix 4 (U10 live): NowLineBar never renders 'Complete' for stopped, failed, incomplete, or no-outcome turns", () => {
    const NOW = 1_700_000_000_000;

    const stopped = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      isStopped: true,
      status: "incomplete",
      nowMs: NOW,
      totalDurationMs: 10_000,
    });
    assert.equal(stopped.actionLabel, "Stopped");

    const failed = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      status: "error",
      nowMs: NOW,
      totalDurationMs: 5_000,
    });
    assert.equal(failed.actionLabel, "Failed");

    const incomplete = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      status: "incomplete",
      nowMs: NOW,
      totalDurationMs: 12_000,
    });
    assert.equal(incomplete.actionLabel, "Incomplete");

    const noOutcome = deriveNowLineState({
      hasRunTurn: true,
      isStreaming: false,
      hasOutcome: false,
      nowMs: NOW,
    });
    assert.notEqual(noOutcome.actionLabel, "Complete");
    assert.equal(noOutcome.tokPerSecLabel, null, "Never fabricate speed without generation timing");

    const failedHtml = renderToString(
      React.createElement(NowLineBar, {
        hasRunTurn: true,
        isStreaming: false,
        status: "error",
        nowMs: NOW,
        totalDurationMs: 5_000,
      })
    );
    assert.ok(failedHtml.includes("Failed"));
    assert.ok(!failedHtml.includes("Complete"));
    assert.ok(!failedHtml.includes("0.0 tok/s"));
  });

  it("ThreadSummary projects liveness, supervisor fields, scope, hostAccess, and traceCount; drawer & sidebar agree", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iter3-summary-parity-"));
    try {
      const store = new ThreadStore(tmpDir);
      const thread = store.createThread({ title: "Observed Board Job", model: "test-model" });
      thread.status = "running";
      thread.needsAttention = true;
      thread.stalledReason = "Waiting for retry";
      thread.autoResumeCount = 2;
      thread.scope = "PROJECT";
      thread.hostAccess = true;
      thread.messages = [
        {
          id: "u1",
          role: "user",
          content: "Run the test suite",
          timestamp: new Date().toISOString(),
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          status: "streaming",
          traces: [
            {
              tool: "host_run_powershell",
              args: { command: "npm test" },
              result: "ok",
              durationMs: 120,
              timestamp: new Date().toISOString(),
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ];
      store.saveThread(thread);

      const summaries = await store.listThreadSummaries();
      const s = summaries.find((item) => item.id === thread.id);
      assert.ok(s, "Summary must exist");
      assert.equal(s.hasStreamingMessage, true);
      assert.equal(s.liveness, "alive", "Streaming summary must project live liveness");
      assert.equal(s.needsAttention, true);
      assert.equal(s.stalledReason, "Waiting for retry");
      assert.equal(s.autoResumeCount, 2);
      assert.equal(s.scope, "PROJECT");
      assert.equal(s.hostAccess, true);
      assert.equal(s.traceCount, 1);

      // Drawer must light up the active indicator when status === "running" or hasStreamingMessage
      const drawerHtml = renderToString(
        React.createElement(NavigationDrawer, {
          isOpen: true,
          onClose: () => {},
          activeView: "sessions",
          onNavigate: () => {},
          onNewSession: () => {},
          threads: [s as unknown as Thread],
          selectedThreadId: s.id,
        })
      );
      assert.ok(
        drawerHtml.includes('data-testid="drawer-thread-live-dot"'),
        "NavigationDrawer must show live indicator for running/streaming summary threads"
      );

      // Sidebar must render liveness badge and trace count from ThreadSummary without needing full messages
      const sidebarHtml = renderToString(
        React.createElement(ThreadsSidebar, {
          threads: [s as unknown as Thread],
          selectedThreadId: s.id,
          onSelectThread: () => {},
          onNewThread: () => {},
        })
      );
      assert.ok(
        sidebarHtml.includes(`data-testid="thread-liveness-${s.id}"`),
        "ThreadsSidebar must render liveness badge from projected ThreadSummary"
      );
      assert.ok(
        sidebarHtml.includes("1 total trace"),
        "ThreadsSidebar must render projected traceCount from ThreadSummary"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Fix 1 — Live client end-state tests (observed controls, SSE ping, auto-follow, poll recovery)", () => {
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    win = new GlobalWindow();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = win as unknown as Window & typeof globalThis;
    globalThis.document = win.document as unknown as Document;
    globalThis.localStorage = win.localStorage as unknown as Storage;
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(
      container as unknown as Parameters<typeof win.document.body.appendChild>[0]
    );
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("observed streaming turn shows Stop button, Queue/Steer selector, live elapsed from activeTurn.startedAt, and hides NowLine on initial-welcome", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    try {
      // 1. Fresh thread with initial-welcome must hide NowLineBar (never false "Complete")
      await act(async () => {
        root.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "test-model",
            reasoningEffort: "medium",
            threadId: "t-welcome",
            messages: [
              {
                id: "initial-welcome",
                role: "assistant",
                content: "Ready.",
              },
            ],
            setMessages: () => {},
          })
        );
      });
      assert.equal(
        container.querySelector('[data-testid="header-now-line"]'),
        null,
        "NowLineBar must be hidden on initial-welcome thread"
      );

      // 2. Observed streaming turn (isLoading=false, lastAssistant.status="streaming", activeTurn.startedAt set)
      const startedAtIso = new Date(Date.now() - 12_000).toISOString();
      const updatedAtIso = new Date(Date.now() - 2_000).toISOString();
      const observedMessages: ChatMessage[] = [
        { id: "u1", role: "user", content: "Run build" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          status: "streaming",
          traces: [],
        },
      ];

      await act(async () => {
        root.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "test-model",
            reasoningEffort: "medium",
            threadId: "t-observed",
            threadUpdatedAt: updatedAtIso,
            activeTurn: { threadId: "t-observed", startedAt: startedAtIso, status: "streaming" },
            messages: observedMessages,
            setMessages: () => {},
          })
        );
      });

      assert.ok(
        container.querySelector('[data-testid="stop-button"]'),
        "Observed streaming turn must render Stop button"
      );
      assert.ok(
        container.querySelector('[aria-label="Mid-Turn Action Selector"]'),
        "Observed streaming turn must render Queue/Steer selector"
      );
      const elapsedEl = container.querySelector('[data-testid="now-line-elapsed"]');
      assert.ok(
        elapsedEl && /\d+s/.test(elapsedEl.textContent || ""),
        `Observed turn before trace 1 must derive elapsed from activeTurn.startedAt, got: ${elapsedEl?.textContent}`
      );
      assert.equal(
        container.querySelector('[data-testid="now-line-stalled"]'),
        null,
        "Observed turn with recent updatedAt must not show stalled"
      );
      assert.equal(
        container.querySelector('[data-testid="now-line-toks"]'),
        null,
        "Must omit tok/s when speed cannot be derived (never fake 0.0 tok/s)"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("(b) auto-follow engages on new rows while at bottom, disengages on scroll-up with 'Live' pill, and re-engages on pill click", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;

    try {
      const renderWithMessages = async (msgs: ChatMessage[]) => {
        await act(async () => {
          root.render(
            React.createElement(ChatStream, {
              onTracesUpdate: () => {},
              activeModel: "test-model",
              reasoningEffort: "medium",
              threadId: "t-follow",
              threadUpdatedAt: new Date().toISOString(),
              messages: msgs,
              setMessages: () => {},
            })
          );
        });
      };

      const initialMsgs: ChatMessage[] = [
        { id: "u1", role: "user", content: "Watch live turn" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          status: "streaming",
          traces: [
            {
              tool: "workspace_read_file",
              args: { path: "src/a.ts" },
              result: "ok",
              durationMs: 10,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      ];
      await renderWithMessages(initialMsgs);

      const scrollEl = container.querySelector('[data-scroll-container="true"]') as HTMLDivElement;
      assert.ok(scrollEl, "Scroll container must exist");

      // Configure geometry: container height 400, content height 1200, user at bottom (scrollTop = 800)
      let currentScrollHeight = 1200;
      Object.defineProperty(scrollEl, "clientHeight", { configurable: true, get: () => 400 });
      Object.defineProperty(scrollEl, "scrollHeight", {
        configurable: true,
        get: () => currentScrollHeight,
      });
      scrollEl.scrollTop = 800;

      // Pill must NOT appear while pinned at bottom
      assert.equal(container.querySelector('[data-testid="live-follow-pill"]'), null);

      // New trace rows land (polled round adds 350px > 100px at once!)
      currentScrollHeight = 1550;
      await renderWithMessages([
        initialMsgs[0],
        {
          ...initialMsgs[1],
          traces: [
            ...(initialMsgs[1].traces || []),
            {
              tool: "host_replace_string",
              args: { path: "src/a.ts", oldString: "a", newString: "b" },
              result: "ok",
              durationMs: 20,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      ]);

      // Auto-follow must advance scrollTop to the new scrollHeight without "show all"
      assert.equal(
        scrollEl.scrollTop,
        1550,
        "Auto-follow must follow new trace rows on observed streaming turn even when growth exceeds 100px"
      );
      assert.equal(container.querySelector('[data-testid="live-follow-pill"]'), null);

      // Clear programmatic scroll guard timer so user scroll is respected
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // User scrolls up away from bottom (distanceFromBottom = 1550 - (500 + 400) = 650 > 90)
      scrollEl.scrollTop = 500;
      await act(async () => {
        const propsKey = Object.keys(scrollEl).find((k) => k.startsWith("__reactProps"));
        assert.ok(propsKey, "Scroll container must have React props");
        (scrollEl as unknown as Record<string, { onScroll?: () => void }>)[propsKey].onScroll?.();
      });

      // Floating "Live" pill must now appear (NOT "Latest"!)
      const pill = container.querySelector('[data-testid="live-follow-pill"]') as HTMLButtonElement;
      assert.ok(pill, "Floating Live pill must appear after scrolling up");
      assert.ok(
        (pill.textContent || "").includes("Live"),
        `Observed streaming pill must read 'Live', got: ${pill.textContent}`
      );

      // Another trace arrives while scrolled up -> scrollTop must STAY at 500 (disengaged)
      currentScrollHeight = 1900;
      await renderWithMessages([
        initialMsgs[0],
        {
          ...initialMsgs[1],
          traces: [
            ...(initialMsgs[1].traces || []),
            {
              tool: "host_replace_string",
              args: { path: "src/a.ts", oldString: "a", newString: "b" },
              result: "ok",
              durationMs: 20,
              timestamp: new Date().toISOString(),
            },
            {
              tool: "workspace_run_command",
              args: { command: "npm test" },
              result: "ok",
              durationMs: 30,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      ]);
      assert.equal(scrollEl.scrollTop, 500, "Auto-follow must stay disengaged while scrolled up");

      // Tap the "Live" pill -> re-engages follow and scrolls to bottom
      await act(async () => {
        const propsKey = Object.keys(pill).find((k) => k.startsWith("__reactProps"));
        (pill as unknown as Record<string, { onClick?: () => void }>)[propsKey!].onClick?.();
      });
      assert.equal(scrollEl.scrollTop, 1900, "Clicking Live pill must jump to bottom");
      assert.equal(
        container.querySelector('[data-testid="live-follow-pill"]'),
        null,
        "Live pill must hide once follow re-engages"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SSE ping events refresh liveness timestamp on locally streaming turns", async () => {
    const encoder = new TextEncoder();
    let releaseStream: (() => void) | null = null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`)
        );
        releaseStream = () => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done", content: "Done." })}\n\n`)
          );
          controller.close();
        };
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/chat")) {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      await act(async () => {
        root.render(
          React.createElement(ChatStream, {
            onTracesUpdate: () => {},
            activeModel: "test-model",
            reasoningEffort: "medium",
            threadId: "t-ping",
          })
        );
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      await act(async () => {
        const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"));
        (
          textarea as unknown as Record<
            string,
            { onChange: (e: { target: { value: string } }) => void }
          >
        )[propsKey!].onChange({ target: { value: "ping test" } });
      });
      const sendBtn = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
      await act(async () => {
        sendBtn.click();
      });

      await waitForCondition(
        () => Boolean(container.querySelector('[data-testid="stop-button"]')),
        "streaming turn to start"
      );
      assert.equal(
        container.querySelector('[data-testid="now-line-stalled"]'),
        null,
        "SSE ping must keep turn live"
      );

      await act(async () => {
        releaseStream?.();
      });
      await waitForCondition(
        () => !container.querySelector('[data-testid="stop-button"]'),
        "streaming turn to finish"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("pollLiveThread recovers after a transient rejected fetch and keeps polling until turn settles", async () => {
    const { default: Home } = await import("../app/page");
    const originalFetch = globalThis.fetch;
    let threadDetailCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/threads") || url.includes("/api/threads?")) {
        return new Response(
          JSON.stringify({
            threads: [
              {
                id: "t-poll-recover",
                title: "Observed poll recover",
                status: "running",
                updatedAt: new Date().toISOString(),
                hasStreamingMessage: true,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/threads/t-poll-recover")) {
        // Only count page.tsx no-store detail/poll calls (ignore ChatStream's compaction rehydration fetch)
        if (init?.cache !== "no-store") {
          return new Response(JSON.stringify({ thread: null }), { status: 200 });
        }
        threadDetailCalls += 1;
        if (threadDetailCalls === 2) {
          throw new Error("transient network blip");
        }
        const isSettled = threadDetailCalls >= 3;
        return new Response(
          JSON.stringify({
            thread: {
              id: "t-poll-recover",
              title: "Observed poll recover",
              status: isSettled ? "completed" : "running",
              updatedAt: new Date().toISOString(),
              messages: [
                { id: "u1", role: "user", content: "Run", timestamp: new Date().toISOString() },
                {
                  id: "a1",
                  role: "assistant",
                  content: isSettled ? "Recovered after transient error." : "",
                  status: isSettled ? "completed" : "streaming",
                  timestamp: new Date().toISOString(),
                },
              ],
            },
            activeTurn: isSettled
              ? null
              : {
                  threadId: "t-poll-recover",
                  startedAt: new Date(Date.now() - 5000).toISOString(),
                  status: "streaming",
                },
            task: null,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      await act(async () => {
        root.render(React.createElement(Home));
      });
      await waitForCondition(
        () =>
          threadDetailCalls >= 3 &&
          (container.textContent || "").includes("Recovered after transient error."),
        "pollLiveThread to recover after transient rejection and render settled response",
        8500
      );
      assert.ok(
        threadDetailCalls >= 3,
        `Expected >= 3 polls including post-error recovery, got ${threadDetailCalls}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
