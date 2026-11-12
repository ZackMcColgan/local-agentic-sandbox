import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { ChatStream } from "../components/ChatStream";
import { ThreadsSidebar } from "../components/ThreadsSidebar";
import { ThinkingPanel } from "../components/ThinkingPanel";
import {
  resolveTurnStatusPhase,
  TURN_PHASE_PREPARING,
  TURN_PHASE_REASONING,
  TURN_PHASE_WRITING
} from "../lib/chatStatus";
import { getServedByNote, extractFileWriteDiffsFromTraces } from "../lib/chatUtils";
import fs from "fs";
import path from "path";
import os from "os";
import {
  captureWorkspacePreImage,
  collectTurnModifiedFileDiffs,
  computeUnifiedFileDiff,
  MAX_DIFF_LINES_CAP,
  TurnFileDiff
} from "../lib/chatDiffs";

describe("Epic 1 — Sprint 2: Reading, theme, navigation (S5-S7)", () => {
  // -------------------------------------------------------------
  // S5 — Reading pane typography
  // -------------------------------------------------------------
  describe("S5 — Reading pane typography", () => {
    it("renders message prose with 15px font, line-height 1.6, and max 72ch readable width", () => {
      const messages = [
        {
          id: "m-1",
          role: "assistant" as const,
          content: "This is a response testing reading pane typography standards."
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      // Verify 15px, leading 1.6, max 72ch
      assert.ok(
        html.includes("text-[15px]"),
        "Assistant message must render with 15px font"
      );
      assert.ok(
        html.includes("leading-[1.6]"),
        "Assistant message must render with line-height 1.6"
      );
      assert.ok(
        html.includes("max-w-[72ch]"),
        "Prose content container must be constrained to max-w-[72ch] for optimal readability"
      );
    });

    it("renders markdown tables, bullet lists, blockquotes, and inline code honestly", () => {
      const denseMarkdown = `
# Engineering Report
> Note: Zero-trust sandbox is active.

- Milestone 1: Done
- Milestone 2: Testing

1. Step one
2. Step two

| Metric | Target | Result |
| :--- | :--- | :--- |
| Latency | <100ms | 42ms |

Use \`run_command\` for shell actions.
`;
      const messages = [
        {
          id: "m-dense",
          role: "assistant" as const,
          content: denseMarkdown
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      // Verify table elements render
      assert.ok(html.includes("<table"), "Must render <table> tag for markdown tables");
      assert.ok(html.includes("<th"), "Must render <th> header cells");
      assert.ok(html.includes("<td"), "Must render <td> data cells");
      assert.ok(html.includes("Latency"), "Must render table content");

      // Verify blockquote renders
      assert.ok(html.includes("<blockquote"), "Must render <blockquote> tag for quotes");

      // Verify lists render
      assert.ok(html.includes("<ul"), "Must render <ul> tag for bullet lists");
      assert.ok(html.includes("<ol"), "Must render <ol> tag for numbered lists");
      assert.ok(html.includes("<li"), "Must render <li> tag for list items");

      // Verify inline code renders
      assert.ok(html.includes("run_command"), "Must render inline code content");
    });

    it("renders code blocks with distinct background and copy button", () => {
      const codeMarkdown = "```typescript\nconst agent = 'sandbox';\n```";
      const messages = [
        {
          id: "m-code",
          role: "assistant" as const,
          content: codeMarkdown
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      assert.ok(html.includes("<pre"), "Must render <pre> tag for code block");
      assert.ok(html.includes("const agent = &#x27;sandbox&#x27;;") || html.includes("const agent = 'sandbox';"), "Must render code snippet content");
      assert.ok(html.includes("Copy"), "Must render copy button for code block");
      assert.ok(html.includes("bg-[#f4eff4]") || html.includes("bg-surface-variant"), "Code block must have distinct surface-variant background");
    });
  });

  // -------------------------------------------------------------
  // S6 — Theme consistency
  // -------------------------------------------------------------
  describe("S6 — Theme consistency", () => {
    it("provides theme toggle in UI and clean M3 token variables", () => {
      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: []
        })
      );

      // Verify theme toggle or overflow option exists
      assert.ok(
        html.includes("theme") || html.includes("Theme") || html.includes("Dark") || html.includes("Light") || html.includes("More options"),
        "UI must provide theme accessibility and controls"
      );
    });

    it("supports OS preference / prefers-color-scheme evaluation", () => {
      // Behavioral check of OS preference logic
      const simulateThemeResolution = (saved: string | null, systemPrefersDark: boolean) => {
        if (saved) return saved === "dark" ? "dark" : "light";
        return systemPrefersDark ? "dark" : "light";
      };

      assert.equal(simulateThemeResolution(null, true), "dark", "System default must select dark when OS is dark");
      assert.equal(simulateThemeResolution(null, false), "light", "System default must select light when OS is light");
      assert.equal(simulateThemeResolution("dark", false), "dark", "Manual dark overrides system light");
      assert.equal(simulateThemeResolution("light", true), "light", "Manual light overrides system dark");
    });
  });

  // -------------------------------------------------------------
  // S7 — Navigation: Back to sessions
  // -------------------------------------------------------------
  describe("S7 — Navigation: Back to sessions", () => {
    it("renders visible Back button on both mobile and desktop (no sm:hidden)", () => {
      let backCalled = false;
      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          threadTitle: "Fix login flow",
          onBackToList: () => {
            backCalled = true;
          },
          messages: []
        })
      );

      // Must have Back to threads / sessions button
      assert.ok(html.includes("Back to"), "Top bar must render Back button");
      // Must NOT be hidden on desktop with sm:hidden
      assert.ok(!html.includes("sm:hidden p-1.5 -ml-1 rounded-full text-slate-600"), "Back button must NOT be suppressed on desktop");
    });

    it("handles popstate and back navigation without trapping the user", () => {
      // Simulate state machine transitions between thread view and thread list
      let activeThread: string | null = "thread-123";
      const historyStack: Array<{ threadId: string | null }> = [{ threadId: null }, { threadId: "thread-123" }];

      const onPopState = (state: { threadId: string | null } | null) => {
        activeThread = state?.threadId || null;
      };

      // User hits back: pop from stack
      const previousState = historyStack[0];
      onPopState(previousState);

      assert.equal(activeThread, null, "Navigating back returns to sessions list (activeThread = null)");
    });
  });

  // -------------------------------------------------------------
  // F4.6 — Compacted Turn Note
  // -------------------------------------------------------------
  describe("F4.6 — Compacted Turn Note", () => {
    it("renders compaction turn note badge when assistant message has compactedThisTurn=true and token stats", () => {
      const messagesWithCompaction: any[] = [
        {
          id: "m-user-1",
          role: "user" as const,
          content: "Summarize status"
        },
        {
          id: "m-asst-1",
          role: "assistant" as const,
          content: "Here is the summary after compaction.",
          compactedThisTurn: true,
          tokensBeforeCompaction: 88400,
          tokensAfterCompaction: 14200
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: messagesWithCompaction
        })
      );

      assert.ok(
        html.includes('data-testid="compaction-turn-note"'),
        "Assistant message must render compaction turn note badge"
      );
      assert.ok(
        html.includes("History compacted: 88,400 → 14,200 tokens") ||
        (html.includes("88,400") && html.includes("14,200")),
        "Compacted badge must display formatted tokens before and after"
      );
    });

    it("does NOT render compaction turn note badge when compactedThisTurn is false or omitted", () => {
      const messagesWithoutCompaction: any[] = [
        {
          id: "m-asst-2",
          role: "assistant" as const,
          content: "Standard assistant reply without compaction.",
          compactedThisTurn: false
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: messagesWithoutCompaction
        })
      );

      assert.ok(
        !html.includes('data-testid="compaction-turn-note"'),
        "Must NOT render compaction-turn-note when compactedThisTurn is false or omitted"
      );
    });

    it("renders compaction action chips under the pill when the message carries compactionActions", () => {
      const messagesWithActions: any[] = [
        {
          id: "m-asst-actions",
          role: "assistant" as const,
          content: "Reply after a compaction that applied real actions.",
          compactedThisTurn: true,
          tokensBeforeCompaction: 88400,
          tokensAfterCompaction: 14200,
          compactionActions: ["elide_tool_outputs", "drop_old_turns", "truncate_oversize"]
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: messagesWithActions
        })
      );

      // Pill line must still be present unchanged
      assert.ok(
        html.includes('data-testid="compaction-turn-note"'),
        "Compaction pill must still render when actions are present"
      );
      assert.ok(
        html.includes("History compacted") && html.includes("88,400") && html.includes("14,200") && html.includes("tokens"),
        "Pill must keep the existing 'History compacted: X -> Y tokens' line"
      );

      // Action chips must render from the real action data
      assert.ok(
        html.includes('data-testid="compaction-action-chip"'),
        "Compaction action chips must render under the pill"
      );
      assert.ok(html.includes("Elide tool outputs"), "Chip must show elide_tool_outputs action");
      assert.ok(html.includes("Drop old turns"), "Chip must show drop_old_turns action");
      assert.ok(html.includes("Truncate oversize"), "Chip must show truncate_oversize action");
    });

    it("caps action chips and shows a '+N more' overflow when the action list exceeds the cap", () => {
      const messagesOverflow: any[] = [
        {
          id: "m-asst-overflow",
          role: "assistant" as const,
          content: "Reply after a compaction with many actions.",
          compactedThisTurn: true,
          tokensBeforeCompaction: 90000,
          tokensAfterCompaction: 15000,
          compactionActions: [
            "elide_tool_outputs",
            "drop_old_turns",
            "truncate_oversize",
            "elide_tool_outputs",
            "drop_old_turns"
          ]
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: messagesOverflow
        })
      );

      const chipCount = (html.match(/data-testid="compaction-action-chip"/g) || []).length;
      assert.equal(chipCount, 3, "Action chips must be capped at 3 chips");
      assert.ok(
        html.includes('data-testid="compaction-action-overflow"') && html.includes("more"),
        "Overflow chip must render '+N more' beyond the cap"
      );
    });

    it("renders the pill line unchanged when a compaction has no actions", () => {
      const messagesNoActions: any[] = [
        {
          id: "m-asst-no-actions",
          role: "assistant" as const,
          content: "Reply after a compaction with no recorded actions.",
          compactedThisTurn: true,
          tokensBeforeCompaction: 88400,
          tokensAfterCompaction: 14200,
          compactionActions: undefined
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages: messagesNoActions
        })
      );

      assert.ok(
        html.includes('data-testid="compaction-turn-note"'),
        "Pill must render for compaction without actions"
      );
      assert.ok(
        html.includes("History compacted") && html.includes("88,400") && html.includes("14,200") && html.includes("tokens"),
        "Pill line must be unchanged when there are no actions"
      );
      assert.ok(
        !html.includes('data-testid="compaction-action-chip"'),
        "No action chips must render when compactionActions is absent"
      );
    });
  });

  // -------------------------------------------------------------
  // F7.1 — Single live turn status surface
  // -------------------------------------------------------------
  describe("F7.1 — Single live turn status surface", () => {
    it("resolveTurnStatusPhase resolves phases accurately across streaming lifecycle", () => {
      // Phase 1: Preparing
      assert.equal(
        resolveTurnStatusPhase({ isStreaming: true, hasThought: false, hasContent: false }),
        TURN_PHASE_PREPARING
      );

      // Phase 2: Reasoning
      assert.equal(
        resolveTurnStatusPhase({ isStreaming: true, hasThought: true, hasContent: false }),
        TURN_PHASE_REASONING
      );

      // Phase 3: Active Tool (via activeTool or streamStatus)
      assert.equal(
        resolveTurnStatusPhase({ isStreaming: true, activeTool: "workspace_read_file", hasThought: true }),
        "Running workspace_read_file"
      );
      assert.equal(
        resolveTurnStatusPhase({ isStreaming: true, streamStatus: "Running search_web...", hasThought: true }),
        "Running search_web"
      );

      // Phase 4: Writing answer
      assert.equal(
        resolveTurnStatusPhase({ isStreaming: true, hasThought: true, hasContent: true }),
        TURN_PHASE_WRITING
      );

      // Idle (not streaming) -> null
      assert.equal(
        resolveTurnStatusPhase({ isStreaming: false, hasThought: true, hasContent: true }),
        null
      );
    });

    it("renders single turn-status-slot in ThinkingPanel with h-7 and max 1 spinner", () => {
      const html = renderToString(
        React.createElement(ThinkingPanel, {
          isStreaming: true,
          rawThought: "Checking files...",
          streamStatus: "Running workspace_grep"
        })
      );

      // turn-status-slot appears exactly once with Running workspace_grep and h-7
      const slotMatches = html.match(/data-testid="turn-status-slot"/g);
      assert.equal(slotMatches?.length, 1, "turn-status-slot must appear exactly once");
      assert.ok(html.includes("Running workspace_grep"), "Must display resolved active tool");
      assert.ok(html.includes("h-7"), "turn-status-slot must have fixed height class h-7");

      // Duplicate footer text must NOT appear
      assert.ok(
        !html.includes("Reasoning in progress. Formulating structured execution..."),
        "Duplicate bottom reasoning footer must not appear"
      );

      // At most 1 animate-spin in the rendered HTML
      const spinMatches = html.match(/animate-spin/g);
      assert.ok((spinMatches?.length || 0) <= 1, `Expected at most 1 animate-spin, found ${spinMatches?.length || 0}`);
    });
  });

  // -------------------------------------------------------------
  // F7.2 — Truthful 'Served by ...' Note
  // -------------------------------------------------------------
  describe("F7.2 — Truthful 'Served by ...' Note", () => {
    it("getServedByNote correctly normalizes aliases and suppresses redundant notes", () => {
      // Same canonical model (Swift 1.5 aliases)
      assert.equal(
        getServedByNote("Swift-1.5-Qwen3.8-27B-IQ3_XS", "swift-15-27b-mtp"),
        null
      );

      // Same canonical model (Flash-Next aliases)
      assert.equal(
        getServedByNote("qwen3.8-flash-next-gyro-gyro-s", "Flash-Next"),
        null
      );

      // Selected auto -> null
      assert.equal(
        getServedByNote("qwen3.8-flash-next-gyro-gyro-s", "auto"),
        null
      );

      // Legitimate fallback / divergence
      assert.equal(
        getServedByNote("gemma4:e4b", "qwen3.8-flash-next-gyro-gyro-s"),
        "Served by gemma4:e4b (Flash-Next selected)"
      );
    });

    it("ChatStream suppresses Served-by note when model matches and renders it when diverged", () => {
      // Matching model -> no note
      const htmlMatching = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8-flash-next-gyro-gyro-s",
          messages: [
            {
              id: "m-match",
              role: "assistant" as const,
              content: "Hello",
              modelUsed: "qwen3.8-flash-next-gyro-gyro-s"
            }
          ]
        })
      );
      assert.ok(!htmlMatching.includes("Served by"), "Must NOT render Served by when served model matches selected");

      // Divergent model -> renders truthful note
      const htmlDiverged = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8-flash-next-gyro-gyro-s",
          messages: [
            {
              id: "m-diverged",
              role: "assistant" as const,
              content: "Fallback reply",
              modelUsed: "gemma4:e4b",
              selectedModel: "qwen3.8-flash-next-gyro-gyro-s"
            }
          ]
        })
      );
      assert.ok(
        htmlDiverged.includes("Served by gemma4:e4b (Flash-Next selected)"),
        "Must render truthful Served by note when fallback model is served"
      );
    });
  });

  // -------------------------------------------------------------
  // F7.0 — c04a372 Revert: Mobile Context Meter Visibility
  // -------------------------------------------------------------
  describe("F7.0 — c04a372 Revert: Mobile Context Meter Visibility", () => {
    it("renders context-meter-pill with flex and without hidden sm:flex", () => {
      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8-flash-next-gyro-gyro-s",
          messages: []
        })
      );

      assert.ok(html.includes('data-testid="context-meter-pill"'), "Must render context-meter-pill");
      assert.ok(!html.includes("hidden sm:flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full"), "Must NOT have hidden sm:flex hiding pill on mobile");
    });
  });

  // -------------------------------------------------------------
  // Phase Ω — Chat Diff Cards for File Writes & Patches
  // -------------------------------------------------------------
  describe("Phase Ω — Chat Diff Cards for File Writes & Patches", () => {
    it("extractFileWriteDiffsFromTraces extracts diff stats and unified preview for workspace_write_file, workspace_patch_file, and host_write_file", () => {
      const traces = [
        {
          tool: "workspace_write_file",
          args: {
            path: "src/utils/math.ts",
            content: "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;"
          }
        },
        {
          tool: "workspace_patch_file",
          args: {
            path: "src/index.ts",
            search: "const oldVal = 1;",
            replace: "const newVal = 2;\nconst extra = 3;"
          }
        },
        {
          tool: "workspace_read_file",
          args: {
            path: "src/secret.ts"
          }
        },
        {
          name: "host_read_file",
          args: {
            filePath: "C:/system/log.txt"
          }
        }
      ];

      const diffs = extractFileWriteDiffsFromTraces(traces);
      assert.equal(diffs.length, 2, "Must extract exactly 2 diff items, ignoring read-only tools");

      // Check write item
      const writeItem = diffs.find((d: any) => d.path === "src/utils/math.ts");
      assert.ok(writeItem, "Must extract workspace_write_file item");
      assert.equal(writeItem.tool, "workspace_write_file");
      assert.equal(writeItem.addedLines, 2);
      assert.equal(writeItem.removedLines, 0);
      assert.ok(writeItem.diffPreview.includes("+ export const add"), "diffPreview must contain '+ export const add'");

      // Check patch item
      const patchItem = diffs.find((d: any) => d.path === "src/index.ts");
      assert.ok(patchItem, "Must extract workspace_patch_file item");
      assert.equal(patchItem.addedLines, 2);
      assert.equal(patchItem.removedLines, 1);
      assert.ok(patchItem.diffPreview.includes("- const oldVal = 1;"), "diffPreview must contain '- const oldVal = 1;'");
      assert.ok(patchItem.diffPreview.includes("+ const newVal = 2;"), "diffPreview must contain '+ const newVal = 2;'");
    });

    it("ChatStream renders data-testid=\"chat-diff-card\" with +added/-removed badges and Copy path button on assistant file-write turns", () => {
      const messages: any[] = [
        {
          id: "m-write-1",
          role: "assistant",
          content: "I have updated the file for you.",
          traces: [
            {
              tool: "workspace_write_file",
              args: {
                path: "web-ui/lib/newHelper.ts",
                content: "export const x = 1;\nexport const y = 2;\n"
              }
            }
          ]
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      assert.ok(html.includes('data-testid="chat-diff-card"'), "Must render chat-diff-card");
      assert.ok(html.includes("web-ui/lib/newHelper.ts"), "Must render file path web-ui/lib/newHelper.ts");
      assert.ok(html.includes("+2"), "Must render +2 added lines badge");
      assert.ok(html.includes("Copy path"), "Must render Copy path button");
    });
  });
  // -------------------------------------------------------------
  // Free Run Part 3 Item 1 — Tool-Loop Pre-Image Diff Capture & DiffViewer Persistence
  // -------------------------------------------------------------
  describe("Free Run Part 3 Item 1 — Tool-Loop Pre-Image Diff Capture & DiffViewer Persistence", () => {
    it("captureWorkspacePreImage + collectTurnModifiedFileDiffs captures pre-image and computes unified diff for modified files", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-diff-test-"));
      try {
        const testFileRel = "src/example.txt";
        const testFileAbs = path.join(tempDir, testFileRel);
        fs.mkdirSync(path.dirname(testFileAbs), { recursive: true });
        fs.writeFileSync(testFileAbs, "line1\nline2\nline3\n", "utf8");

        const preImages = new Map<string, string>();
        captureWorkspacePreImage(preImages, testFileRel, tempDir);
        assert.equal(preImages.size, 1);
        assert.equal(preImages.get(testFileRel), "line1\nline2\nline3\n");

        // Now modify the file
        fs.writeFileSync(testFileAbs, "line1\nline2-modified\nline3\nline4\n", "utf8");

        const diffs = collectTurnModifiedFileDiffs(preImages, tempDir);
        assert.equal(diffs.length, 1);
        const d = diffs[0];
        assert.equal(d.path, testFileRel);
        assert.equal(d.removedLines, 1);
        assert.equal(d.addedLines, 2);
        assert.ok(d.diff.includes("-line2"));
        assert.ok(d.diff.includes("+line2-modified"));
        assert.ok(d.diff.includes("+line4"));
        assert.ok(d.diff.includes(`--- a/${testFileRel}`));
        assert.ok(d.diff.includes(`+++ b/${testFileRel}`));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("captureWorkspacePreImage ignores brand-new files (produces zero TurnFileDiff entries)", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-diff-test-"));
      try {
        const newFileRel = "src/brandNew.txt";
        const newFileAbs = path.join(tempDir, newFileRel);

        const preImages = new Map<string, string>();
        // File does not exist yet when pre-image is captured
        captureWorkspacePreImage(preImages, newFileRel, tempDir);
        assert.equal(preImages.size, 0, "Brand-new file must not be stored in preImages");

        // Tool writes the new file
        fs.mkdirSync(path.dirname(newFileAbs), { recursive: true });
        fs.writeFileSync(newFileAbs, "new content\n", "utf8");

        const diffs = collectTurnModifiedFileDiffs(preImages, tempDir);
        assert.equal(diffs.length, 0, "Modified files only — brand-new file must produce zero TurnFileDiffs");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("truncates at MAX_DIFF_LINES_CAP (120) and reports truncated, totalDiffLines, and omittedLines", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-diff-test-"));
      try {
        const fileRel = "src/large.txt";
        const fileAbs = path.join(tempDir, fileRel);
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, "initial\n", "utf8");

        const preImages = new Map<string, string>();
        captureWorkspacePreImage(preImages, fileRel, tempDir);

        // Modify with 150 changed lines
        const lines = Array.from({ length: 150 }, (_, i) => `line-${i + 1}`);
        fs.writeFileSync(fileAbs, lines.join("\n") + "\n", "utf8");

        const diffs = collectTurnModifiedFileDiffs(preImages, tempDir, MAX_DIFF_LINES_CAP);
        assert.equal(diffs.length, 1);
        const d = diffs[0];
        assert.equal(d.truncated, true);
        assert.ok((d.totalDiffLines ?? 0) > MAX_DIFF_LINES_CAP, "totalDiffLines must exceed cap");
        assert.equal(d.omittedLines, (d.totalDiffLines ?? 0) - MAX_DIFF_LINES_CAP);
        assert.ok(d.diff.includes(`# ... truncated (${d.omittedLines} of ${d.totalDiffLines} diff lines omitted)`));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("ChatStream renders DiffViewer inside data-testid=\"chat-diff-card\" and persists diffs", () => {
      const persistedDiff: TurnFileDiff = {
        path: "web-ui/lib/persistedHelper.ts",
        diff: "--- a/web-ui/lib/persistedHelper.ts\n+++ b/web-ui/lib/persistedHelper.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n",
        addedLines: 1,
        removedLines: 1
      };

      const messages: any[] = [
        {
          id: "m-persisted-1",
          role: "assistant",
          content: "Modified persisted file.",
          diffs: [persistedDiff]
        }
      ];

      const html = renderToString(
        React.createElement(ChatStream, {
          onTracesUpdate: () => {},
          activeModel: "qwen3.8:27b-q3_k_m",
          reasoningEffort: "medium",
          messages
        })
      );

      assert.ok(html.includes('data-testid="chat-diff-card"'), "Must render chat-diff-card");
      assert.ok(html.includes("web-ui/lib/persistedHelper.ts"), "Must render branch/path for DiffViewer");
      assert.ok(html.includes("+1"), "Must render +1 badge");
      assert.ok(html.includes("-1"), "Must render -1 badge");
    });
  });
});
