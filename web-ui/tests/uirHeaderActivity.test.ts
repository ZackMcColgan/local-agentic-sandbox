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
  formatThoughtLabel
} from "../lib/liveActivity";
import { LiveActivityHeader } from "../components/LiveActivityHeader";
import { ThinkingPanel } from "../components/ThinkingPanel";

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
      hostDisconnectChipVisible({ hostAccess: true, runnerState: "UNAVAILABLE", runnerAvailable: false }),
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
      hostDisconnectChipVisible({ hostAccess: false, runnerState: "UNAVAILABLE", runnerAvailable: false }),
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
    assert.equal(streamBannerKind({ isDisconnected: true, recoveredAtMs: null, nowMs: now }), "disconnected");
    assert.equal(streamBannerKind({ isDisconnected: false, recoveredAtMs: now - 3_000, nowMs: now }), "recovered");
    assert.equal(streamBannerKind({ isDisconnected: false, recoveredAtMs: now - 30_000, nowMs: now }), null);
    assert.equal(streamBannerKind({ isDisconnected: false, recoveredAtMs: null, nowMs: now }), null);
  });

  it("formatThoughtLabel renders the collapsed end-of-turn row label", () => {
    assert.equal(formatThoughtLabel(161_000), "Thought for 2m 41s");
    assert.equal(formatThoughtLabel(9_000), "Thought for 9s");
  });
});

describe("uir-1 — LiveActivityHeader rendering", () => {
  const NOW = 1_700_000_000_000;

  it("hero readout is elapsed time only, with Round/traces mono meta and no percentages", () => {
    const html = renderToString(
      React.createElement(LiveActivityHeader, {
        startedAtMs: NOW - 862_000,
        lastActivityAtMs: NOW - 2_000,
        nowMs: NOW,
        round: 74,
        traceCount: 73,
        phaseLabel: "Writing code — host_run_file_write",
        activityLabel: null,
        isStreaming: true
      })
    );
    assert.ok(html.includes('data-testid="live-activity-header"'), "header testid present");
    assert.ok(html.includes('data-testid="live-activity-elapsed"'), "elapsed testid present");
    assert.ok(html.includes("14m 22s"), "elapsed hero shows 14m 22s");
    assert.ok(html.includes("Round 74 · 73 traces"), "mono meta shows Round N · M traces");
    // Parity PR2: the tool half of the phase line renders in its own mono
    // muted span (board styling), so the full label is asserted on the
    // tag-stripped rendered text — same semantic guarantee.
    const renderedText = html.replace(/<[^>]+>/g, "");
    assert.ok(renderedText.includes("Writing code — host_run_file_write"), "phase label in words with tool");
    assert.ok(html.includes("Live"), "freshness shows Live");
    assert.ok(!html.includes("%"), "no percentage anywhere in the activity header");
  });

  it("shows the STALLED chip when no activity has arrived for over 45s", () => {
    const html = renderToString(
      React.createElement(LiveActivityHeader, {
        startedAtMs: NOW - 300_000,
        lastActivityAtMs: NOW - 90_000,
        nowMs: NOW,
        traceCount: 12,
        phaseLabel: "Running command — run_command",
        activityLabel: null,
        isStreaming: true
      })
    );
    assert.ok(html.includes('data-testid="live-activity-stalled"'), "stalled chip testid present");
    assert.ok(html.includes("STALLED · No heartbeat for 90s"), "stalled chip carries the silent duration");
  });

  it("omits the Round meta segment when the round is not known (never fabricates it)", () => {
    const html = renderToString(
      React.createElement(LiveActivityHeader, {
        startedAtMs: NOW - 5_000,
        lastActivityAtMs: NOW - 1_000,
        nowMs: NOW,
        traceCount: 1,
        phaseLabel: "Starting turn…",
        activityLabel: null,
        isStreaming: true
      })
    );
    assert.ok(html.includes("1 trace"), "trace meta present with singular form");
    assert.ok(!html.includes("Round "), "no Round segment when round is unknown");
  });
});

describe("uir-1 — ThinkingPanel fake progress bar is deleted", () => {
  it("ThinkingPanel source has no 0/100 progress assignment, no 5% floor clamp, no percent label", () => {
    const src = readSrc("components/ThinkingPanel.tsx");
    assert.ok(!src.includes("progressPercent: isStreaming ? 0 : 100"), "fake 0/100 assignment removed");
    assert.ok(!src.includes("Math.min(Math.max(phaseItem.progressPercent, 5), 100)"), "5% floor clamp removed");
    assert.ok(!src.includes("In progress ·"), "percent progress label removed");
  });

  it("streaming render shows the Thinking header and no percent text", () => {
    const html = renderToString(
      React.createElement(ThinkingPanel, {
        isStreaming: true,
        rawThought: "Checking the files and planning the patch...",
        streamStatus: "Running workspace_grep"
      })
    );
    assert.ok(html.includes("Thinking"), "header shows Thinking while streaming");
    assert.ok(!/In progress · \d+%/.test(html), "no percent progress text rendered");
    assert.ok(!html.includes('data-testid="thinking-progress-bar"'), "no progress bar element");
  });

  it("ThinkingPanel source carries the Thought-for end-state label", () => {
    const src = readSrc("components/ThinkingPanel.tsx");
    assert.ok(src.includes("formatThoughtLabel"), "collapsed row uses the Thought-for label helper");
  });
});

describe("uir-0 — header diet in ChatStream", () => {
  const src = readSrc("components/ChatStream.tsx");

  it("Engine pill and Host status chip are gone from the header", () => {
    assert.ok(!src.includes("<EngineStatusPill"), "EngineStatusPill no longer mounted in ChatStream");
    assert.ok(!src.includes('data-testid="host-access-chip"'), "host status chip removed from header");
  });

  it("the only header guest is the amber host-disconnect alert chip", () => {
    assert.ok(src.includes('data-testid="host-disconnect-chip"'), "disconnect chip testid present");
    assert.ok(src.includes("HOST DISCONNECTED · OPEN SETTINGS"), "chip carries the alert label");
    assert.ok(src.includes("hostDisconnectChipVisible"), "chip visibility comes from the pure helper");
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

  it("Live Activity Header is wired into the streaming message and banners exist", () => {
    assert.ok(src.includes("<LiveActivityHeader"), "LiveActivityHeader mounted for the streaming turn");
    assert.ok(src.includes('data-testid="turn-transient-disconnected"'), "disconnected banner keeps its testid");
    assert.ok(src.includes("DISCONNECTED"), "disconnected banner label present");
    assert.ok(src.includes('data-testid="stream-recovered-banner"'), "recovered banner testid present");
    assert.ok(src.includes("RECOVERED"), "recovered banner label present");
    assert.ok(src.includes('data-testid="turn-done-chip"'), "done chip replaces the header at turn end");
  });

  it("page.tsx passes a settings opener so the disconnect chip can open Settings", () => {
    const page = readSrc("app/page.tsx");
    assert.ok(page.includes("onOpenSettings"), "page wires onOpenSettings into ChatStream");
  });
});
