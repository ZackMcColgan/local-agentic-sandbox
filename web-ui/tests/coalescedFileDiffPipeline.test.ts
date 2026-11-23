import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import {
  buildActivityTimeline,
  classifyToolKind,
  coalesceTimelineWriteDiffs,
  extractWriteDiffFromTrace,
  mergeLiveAndSettledTraces,
} from "../lib/activityTimeline";
import { coalesceTurnDiffs } from "../lib/chatDiffs";
import { extractFileWriteDiffsFromTraces, resolveFileOpenUrl } from "../lib/chatUtils";
import { deriveStintMetrics } from "../lib/stintDerivation";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { CanvasDiffSheet } from "../components/CanvasDiffSheet";
import { ChatMessageItem } from "../components/chat/messageRender";
import { CanvasProvider } from "../components/CanvasContext";
import { GET as filesGet } from "../app/api/files/route";

describe("Fix 3 (U3, U17) — Coalesced per-file cards, host_replace_string, single pipeline, working host links", () => {
  it("classifies host_replace_string as write, extracts unified diff, and includes it in StintCard metrics", () => {
    assert.equal(classifyToolKind("host_replace_string"), "write");

    const trace = {
      tool: "host_replace_string",
      args: {
        path: "C:\\repo\\web-ui\\lib\\turnSpeed.ts",
        oldString: "const a = 1;\nconst b = 2;",
        newString: "const a = 1;\nconst b = 3;\nconst c = 4;",
      },
      result: { ok: true },
      durationMs: 42,
      timestamp: "2026-11-22T12:00:00.000Z",
    };

    const diff = extractWriteDiffFromTrace(trace);
    assert.ok(diff, "host_replace_string must produce a TimelineWriteDiff");
    assert.equal(diff.addedLines, 2);
    assert.equal(diff.removedLines, 1);
    assert.ok(diff.diffText?.includes("-const b = 2;"));
    assert.ok(diff.diffText?.includes("+const b = 3;"));
    assert.ok(diff.diffText?.includes("+const c = 4;"));

    const stint = deriveStintMetrics({ traces: [trace] });
    assert.ok(stint?.files, "StintCard must count host_replace_string files");
    assert.equal(stint.files.count, 1);
    assert.equal(stint.files.addedLines, 2);
    assert.equal(stint.files.removedLines, 1);
  });

  it("(c) two writes to the same file in one turn render one coalesced card with summed +/- across timeline, diff sheet, and TurnFileDiffs", () => {
    const filePath = "C:\\repo\\web-ui\\lib\\sample.ts";
    const traces = [
      {
        tool: "host_replace_string",
        args: {
          path: filePath,
          oldString: "const x = 1;",
          newString: "const x = 2;\nconst y = 3;",
        },
        result: { ok: true },
        durationMs: 15,
        round: 1,
        timestamp: "2026-11-22T12:00:01.000Z",
      },
      {
        tool: "host_replace_string",
        args: {
          path: filePath.replace(/\\/g, "/"),
          oldString: "const y = 3;",
          newString: "const y = 4;\nconst z = 5;\nconst w = 6;",
        },
        result: { ok: true },
        durationMs: 20,
        round: 2,
        timestamp: "2026-11-22T12:00:02.000Z",
      },
    ];

    // 1. Timeline coalesces both writes to the same file into ONE write row with summed +/- (+5 -2)
    const rows = buildActivityTimeline(traces);
    const writeRows = rows.filter((r) => r.kind === "write");
    assert.equal(
      writeRows.length,
      1,
      "Two writes to the same file must coalesce to 1 timeline row"
    );
    assert.equal(writeRows[0].writeDiff?.addedLines, 5);
    assert.equal(writeRows[0].writeDiff?.removedLines, 2);
    assert.ok(writeRows[0].writeDiff?.diffText?.includes("+const w = 6;"));

    // Rendered ActivityTimeline has exactly 1 write card showing +5 and -2
    const timelineHtml = renderToString(
      React.createElement(ActivityTimeline, {
        traces,
        onOpenCanvasDiff: () => {},
      })
    );
    const openCanvasBtnMatches = timelineHtml.match(/data-testid="open-in-canvas-btn"/g) || [];
    assert.equal(openCanvasBtnMatches.length, 1, "Exactly one coalesced file card rendered");
    const plainTimelineText = timelineHtml.replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(plainTimelineText.includes("+5"), "Coalesced card shows summed +5");
    assert.ok(plainTimelineText.includes("−2"), "Coalesced card shows summed −2");

    // 2. coalesceTimelineWriteDiffs deduplicates for CanvasDiffSheet (unique keys, no duplicate chips)
    const coalescedSheetDiffs = coalesceTimelineWriteDiffs([
      { filePath, addedLines: 2, removedLines: 1, diffText: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
      {
        filePath: filePath.replace(/\\/g, "/"),
        addedLines: 3,
        removedLines: 1,
        diffText: "@@ -2 +2,3 @@\n-c\n+d\n+e\n+f",
      },
    ]);
    assert.equal(coalescedSheetDiffs.length, 1);
    assert.equal(coalescedSheetDiffs[0].addedLines, 5);
    assert.equal(coalescedSheetDiffs[0].removedLines, 2);

    const sheetHtml = renderToString(
      React.createElement(CanvasDiffSheet, {
        currentDiff: coalescedSheetDiffs[0],
        allDiffs: coalescedSheetDiffs,
        onSelectDiff: () => {},
        onClose: () => {},
      })
    );
    assert.ok(!sheetHtml.includes('data-testid="canvas-diff-file-chips"'));

    // 3. coalesceTurnDiffs & extractFileWriteDiffsFromTraces coalesce by normalized path with summed +/-
    const turnDiffs = coalesceTurnDiffs([
      { path: filePath, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c", addedLines: 2, removedLines: 1 },
      {
        path: filePath.replace(/\\/g, "/"),
        diff: "@@ -2 +2,3 @@\n-c\n+d\n+e\n+f",
        addedLines: 3,
        removedLines: 1,
      },
    ]);
    assert.equal(turnDiffs.length, 1);
    assert.equal(turnDiffs[0].addedLines, 5);
    assert.equal(turnDiffs[0].removedLines, 2);

    const extracted = extractFileWriteDiffsFromTraces(traces);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].addedLines, 5);
    assert.equal(extracted[0].removedLines, 2);
  });

  it("(e) a tool call present in both live preview and settled trace renders exactly once; duplicate surfaces & LiveActivityHeader retired", () => {
    const sharedTrace = {
      tool: "workspace_run_command",
      args: { command: "npm test" },
      result: "14 passed",
      durationMs: 120,
      timestamp: "2026-11-22T12:00:05.000Z",
    };

    const merged = mergeLiveAndSettledTraces([sharedTrace], [sharedTrace]);
    assert.equal(merged.length, 1, "Duplicate live + settled trace must merge to 1");

    const html = renderToString(
      React.createElement(
        CanvasProvider,
        null,
        React.createElement(ChatMessageItem, {
          message: {
            id: "a1",
            role: "assistant",
            content: "Tests passed.",
            traces: [sharedTrace],
            status: "streaming",
          },
          idx: 0,
          copiedMessageId: null,
          lastLinkedTaskMsgIndex: -1,
          lastAssistantIndex: 0,
          liveTurnTraces: [sharedTrace],
          isLoading: true,
          isStoppingTask: false,
          activeAssistantMsgId: "a1",
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
        })
      )
    );

    const toolRowMatches = html.match(/aria-label="Tool: workspace_run_command"/g) || [];
    assert.equal(
      toolRowMatches.length,
      1,
      `Tool call must render exactly once live and settled, got ${toolRowMatches.length}`
    );
    assert.ok(!html.includes("Details · Expand Proof"), "Legacy proof cards must be retired");

    // LiveActivityHeader.tsx must be deleted and ChatStream must not render legacy live-trace-rows
    const webUiRoot = path.resolve(__dirname, "..");
    assert.equal(
      fs.existsSync(path.join(webUiRoot, "components/LiveActivityHeader.tsx")),
      false,
      "Orphaned LiveActivityHeader.tsx must be deleted"
    );
    const chatStreamSrc = fs.readFileSync(
      path.join(webUiRoot, "components/ChatStream.tsx"),
      "utf8"
    );
    assert.ok(
      !chatStreamSrc.includes('data-testid="live-trace-rows"'),
      "Legacy live-trace-rows surface in ChatStream.tsx must be retired"
    );
  });

  it("host file links open valid host repo files via /api/files without 403/404, while blocking traversal & out-of-root paths", async () => {
    const absHostFile = path.resolve(__dirname, "../lib/turnSpeed.ts");
    const openUrl = resolveFileOpenUrl(absHostFile);
    assert.ok(openUrl.startsWith("/api/files?path="));

    const res = await filesGet(new NextRequest(`http://localhost${openUrl}`));
    assert.equal(res.status, 200, "Valid absolute host file inside repo must return 200");
    const body = await res.text();
    assert.ok(body.includes("deriveNowLineState"), "Response must contain the actual file content");

    // Traversal must still be strictly blocked (403)
    const traversalRes = await filesGet(
      new NextRequest("http://localhost/api/files?path=../../etc/passwd")
    );
    assert.equal(traversalRes.status, 403);

    // Out-of-root host path must still be rejected (403 or 404)
    const outsideRes = await filesGet(
      new NextRequest("http://localhost/api/files?path=C:\\Windows\\System32\\drivers\\etc\\hosts")
    );
    assert.ok(outsideRes.status === 403 || outsideRes.status === 404 || outsideRes.status === 415);
  });
});
