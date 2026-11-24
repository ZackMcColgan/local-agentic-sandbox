import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import {
  phaseLabelForTool,
  freshnessFor,
  hostDisconnectChipVisible,
  streamBannerKind,
  formatThoughtLabel,
} from "../lib/liveActivity";
import { NowLineBar } from "../components/NowLineBar";
import { ThinkingPanel } from "../components/ThinkingPanel";
import { ChatStream } from "../components/ChatStream";

const webUiRoot = path.resolve(__dirname, "..");
const readSrc = (rel: string) => fs.readFileSync(path.join(webUiRoot, rel), "utf8");

describe("uir-0/uir-1 — liveActivity pure helpers", () => {
  it("phaseLabelForTool maps tool names to phase words plus the tool name", () => {
    assert.equal(phaseLabelForTool("host_run_file_write"), "Writing code — host_run_file_write");
    assert.equal(phaseLabelForTool("host_run_file_read"), "Reading repo — host_run_file_read");
    assert.equal(phaseLabelForTool("run_command"), "Running command — run_command");
    assert.equal(phaseLabelForTool("workspace_grep"), "Searching repo — workspace_grep");
    assert.equal(phaseLabelForTool("search_web"), "Searching the web — search_web");
  });

  it("phaseLabelForTool falls back honestly when no tool is active", () => {
    assert.equal(phaseLabelForTool(null), "Starting turn…");
    assert.equal(phaseLabelForTool(""), "Starting turn…");
    assert.equal(phaseLabelForTool("some_new_tool"), "Working — some_new_tool");
  });

  it("freshnessFor classifies live / idle / stalled from last activity", () => {
    const now = 1_000_000_000;
    assert.deepEqual(freshnessFor(now - 5_000, now), { state: "live", secondsAgo: 5 });
    assert.deepEqual(freshnessFor(now - 30_000, now), { state: "idle", secondsAgo: 30 });
    assert.deepEqual(freshnessFor(now - 90_000, now), { state: "stalled", secondsAgo: 90 });
    // Boundaries: 14s is still live, 45s is still idle, 46s is stalled
    assert.equal(freshnessFor(now - 14_000, now).state, "live");
    assert.equal(freshnessFor(now - 45_000, now).state, "idle");
    assert.equal(freshnessFor(now - 46_000, now).state, "stalled");
  });

  it("hostDisconnectChipVisible is true only while the host runner is down", () => {
    assert.equal(
      hostDisconnectChipVisible({
        hostAccess: true,
        runnerState: "UNAVAILABLE",
        runnerAvailable: false,
      }),
      true
    );
    assert.equal(
      hostDisconnectChipVisible({ hostAccess: true, runnerState: null, runnerAvailable: false }),
      true
    );
    // Host reachable -> no chip
    assert.equal(
      hostDisconnectChipVisible({ hostAccess: true, runnerState: "READY", runnerAvailable: true }),
      false
    );
    // Access disabled in Settings is a choice, not a disconnect -> no chip
    assert.equal(
      hostDisconnectChipVisible({
        hostAccess: false,
        runnerState: "UNAVAILABLE",
        runnerAvailable: false,
      }),
      false
    );
    // Unknown state -> no chip (never cry wolf)
    assert.equal(
      hostDisconnectChipVisible({ hostAccess: true, runnerState: null, runnerAvailable: null }),
      false
    );
  });

  it("streamBannerKind shows disconnected, then recovered briefly, then nothing", () => {
    const now = 1_000_000_000;
    assert.equal(
      streamBannerKind({ isDisconnected: true, recoveredAtMs: null, nowMs: now }),
      "disconnected"
    );
    assert.equal(
      streamBannerKind({ isDisconnected: false, recoveredAtMs: now - 3_000, nowMs: now }),
      "recovered"
    );
    assert.equal(
      streamBannerKind({ isDisconnected: false, recoveredAtMs: now - 30_000, nowMs: now }),
      null
    );
    assert.equal(
      streamBannerKind({ isDisconnected: false, recoveredAtMs: null, nowMs: now }),
      null
    );
  });

  it("formatThoughtLabel renders the collapsed end-of-turn row label", () => {
    assert.equal(formatThoughtLabel(161_000), "Thought for 2m 41s");
    assert.equal(formatThoughtLabel(9_000), "Thought for 9s");
  });
});

describe("uir-1 — LiveActivityHeader retired in favor of NowLineBar + ActivityTimeline", () => {
  const NOW = 1_700_000_000_000;

  it("U17: orphaned LiveActivityHeader.tsx is deleted", () => {
    assert.equal(
      fs.existsSync(path.join(webUiRoot, "components/LiveActivityHeader.tsx")),
      false,
      "Orphaned LiveActivityHeader.tsx must not exist"
    );
  });

  it("Fix 1: NowLineBar carries the stall signal in place of the retired live-activity panel", () => {
    const html = renderToString(
      React.createElement(NowLineBar, {
        hasRunTurn: true,
        isStreaming: true,
        startedAtMs: NOW - 300_000,
        lastActivityAtMs: NOW - 90_000,
        nowMs: NOW,
        traces: [
          { tool: "workspace_run_command", args: { command: "npm test" }, status: "running" },
        ],
      })
    );
    assert.ok(html.includes('data-testid="now-line-stalled"'), "now-line carries stalled testid");
    assert.ok(
      html.includes("Stalled · no heartbeat 90s"),
      "now-line carries the silent heartbeat duration"
    );
  });
});

describe("uir-1 — ThinkingPanel fake progress bar is deleted", () => {
  it("ThinkingPanel source has no 0/100 progress assignment, no 5% floor clamp, no percent label", () => {
    const src = readSrc("components/ThinkingPanel.tsx");
    assert.ok(
      !src.includes("progressPercent: isStreaming ? 0 : 100"),
      "fake 0/100 assignment removed"
    );
    assert.ok(
      !src.includes("Math.min(Math.max(phaseItem.progressPercent, 5), 100)"),
      "5% floor clamp removed"
    );
    assert.ok(!src.includes("In progress ·"), "percent progress label removed");
  });

  it("streaming render shows the Thinking header and no percent text", () => {
    const html = renderToString(
      React.createElement(ThinkingPanel, {
        isStreaming: true,
        rawThought: "Checking the files and planning the patch...",
        streamStatus: "Running workspace_grep",
      })
    );
    assert.ok(html.includes("Thinking"), "header shows Thinking while streaming");
    assert.ok(!/In progress · \d+%/.test(html), "no percent progress text rendered");
    assert.ok(!html.includes('data-testid="thinking-progress-bar"'), "no progress bar element");
  });

  it("ThinkingPanel source carries the Thought-for end-state label", () => {
    const src = readSrc("components/ThinkingPanel.tsx");
    assert.ok(
      src.includes("formatThoughtLabel"),
      "collapsed row uses the Thought-for label helper"
    );
  });
});

describe("uir-0 — header diet in ChatStream", () => {
  const src =
    readSrc("components/ChatStream.tsx") + "\n" + readSrc("components/chat/messageRender.tsx");

  it("Engine pill and Host status chip are gone from the header", () => {
    assert.ok(
      !src.includes("<EngineStatusPill"),
      "EngineStatusPill no longer mounted in ChatStream"
    );
    assert.ok(
      !src.includes('data-testid="host-access-chip"'),
      "host status chip removed from header"
    );
  });

  it("the only header guest is the amber host-disconnect alert chip", () => {
    assert.ok(src.includes('data-testid="host-disconnect-chip"'), "disconnect chip testid present");
    assert.ok(src.includes("HOST DISCONNECTED · OPEN SETTINGS"), "chip carries the alert label");
    assert.ok(
      src.includes("hostDisconnectChipVisible"),
      "chip visibility comes from the pure helper"
    );
  });

  it("context meter track is widened with the 85K redline tick", () => {
    assert.ok(src.includes('data-testid="context-meter-track"'), "meter track testid present");
    assert.ok(src.includes("w-[128px]"), "mobile track widened to 128px");
    assert.ok(src.includes("@lg/chat:w-[240px]"), "desktop track widened to 240px");
    assert.ok(src.includes('data-testid="context-meter-tick"'), "redline tick testid present");
    assert.ok(src.includes("left-[85%]"), "tick sits at the 85% compaction trigger");
  });

  it("Chat|Build composer toggle is removed but the /build route stays intact", () => {
    assert.ok(!src.includes("Composer Mode Selector"), "composer mode radiogroup removed");
    assert.ok(
      src.includes('composerMode === "build" || isBuildPrefix'),
      "build dispatch still routes via composerMode or the /build prefix"
    );
  });

  it("Fix 1: ActivityTimeline is the single live trace surface (LiveActivityHeader unmounted) and NowLineBar + banners exist", () => {
    const messageRenderSrc = readSrc("components/chat/messageRender.tsx");
    const chatStreamSrc = readSrc("components/ChatStream.tsx");
    assert.ok(
      !messageRenderSrc.includes("<LiveActivityHeader"),
      "LiveActivityHeader no longer mounted on streaming turns (single live surface)"
    );
    assert.ok(
      messageRenderSrc.includes("<ActivityTimeline"),
      "ActivityTimeline is the single trace renderer"
    );
    assert.ok(
      chatStreamSrc.includes("<NowLineBar") &&
        chatStreamSrc.includes("lastActivityAtMs={effectiveLastActivityAtMs}"),
      "NowLineBar receives effectiveLastActivityAtMs for stall detection"
    );
    assert.ok(
      src.includes('data-testid="turn-transient-disconnected"'),
      "disconnected banner keeps its testid"
    );
    assert.ok(src.includes("DISCONNECTED"), "disconnected banner label present");
    assert.ok(
      src.includes('data-testid="stream-recovered-banner"'),
      "recovered banner testid present"
    );
    assert.ok(src.includes("RECOVERED"), "recovered banner label present");
    assert.ok(
      src.includes('data-testid="turn-done-chip"'),
      "done chip replaces the header at turn end"
    );
  });

  it("page.tsx passes a settings opener so the disconnect chip can open Settings", () => {
    const page = readSrc("app/page.tsx") + "\n" + readSrc("components/ViewShell.tsx");
    assert.ok(page.includes("onOpenSettings"), "page wires onOpenSettings into ChatStream");
  });

  it("globals.css provides a reduced-motion fallback for .live-activity-pulse", () => {
    const cssSrc = readSrc("app/globals.css");
    assert.ok(
      cssSrc.includes("prefers-reduced-motion: reduce") && cssSrc.includes(".live-activity-pulse"),
      "globals.css provides a reduced-motion fallback for .live-activity-pulse"
    );
  });

  it("U-F6 Header Lock: <header> contains only hamburger + context meter + model pill on mobile while status chips sit in sub-header strip", () => {
    const html = renderToString(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "qwen3.8:27b-q3_k_m",
        reasoningEffort: "medium",
        messages: [],
        onOpenDrawer: () => {},
        supervisorState: { needsAttention: true },
        threadScope: "PROJECT",
        initialSimulation: { scenarioKey: "chat-fast" },
      })
    );

    const headerMatch = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/);
    assert.ok(headerMatch, "ChatStream must render a <header> element");
    const headerHtml = headerMatch[0];

    // The 3 locked mobile header controls must be inside <header>
    assert.ok(
      headerHtml.includes('aria-label="Open navigation menu"'),
      "header must contain hamburger control"
    );
    assert.ok(
      headerHtml.includes('data-testid="context-meter-pill"'),
      "header must contain context meter pill"
    );
    assert.ok(headerHtml.includes("Configure model:"), "header must contain model pill");

    // Status chips must NOT be inside <header>
    assert.ok(
      !headerHtml.includes('data-testid="supervisor-needs-attention"'),
      "SupervisorStatusBadge must be relocated out of <header>"
    );
    assert.ok(
      !headerHtml.includes('data-testid="simulation-badge"'),
      "SIMULATION badge must be relocated out of <header>"
    );
    assert.ok(
      !headerHtml.includes("Compacted"),
      "Compacted pill must be relocated out of <header>"
    );
    assert.ok(
      !headerHtml.includes('data-testid="host-disconnect-chip"'),
      "host-disconnect-chip must be relocated out of <header>"
    );

    // Status chips must render in the sub-header banner strip outside <header>
    assert.ok(
      html.includes('data-testid="chat-subheader-strip"'),
      "sub-header strip must render when status chips are active"
    );
    assert.ok(
      html.includes('data-testid="supervisor-needs-attention"'),
      "SupervisorStatusBadge still renders in sub-header strip"
    );
    assert.ok(
      html.includes('data-testid="simulation-badge"'),
      "SIMULATION badge still renders in sub-header strip"
    );

    // Source verification: all 5 status chips live inside chat-subheader-strip after </header>
    const chatStreamSrc = readSrc("components/ChatStream.tsx");
    const headerEnd = chatStreamSrc.indexOf("</header>");
    const stripStart = chatStreamSrc.indexOf('data-testid="chat-subheader-strip"');
    const nowLineStart = chatStreamSrc.indexOf("<NowLineBar");
    assert.ok(headerEnd > 0 && stripStart > headerEnd && nowLineStart > stripStart);
    const stripSrc = chatStreamSrc.slice(stripStart, nowLineStart);
    assert.ok(stripSrc.includes("<SupervisorStatusBadge"), "SupervisorStatusBadge in strip");
    assert.ok(stripSrc.includes('data-testid="simulation-badge"'), "simulation-badge in strip");
    assert.ok(stripSrc.includes("Compacted"), "Compacted pill in strip");
    assert.ok(
      stripSrc.includes('data-testid="host-disconnect-chip"'),
      "host-disconnect-chip in strip"
    );
  });
});
