import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildActivityTimeline,
  classifyToolKind,
  foldTimelineRows,
  traceToTimelineRow,
  type TimelineTraceInput,
} from "../lib/activityTimeline";
import { parseUnifiedDiffWithLineNumbers } from "../components/CanvasDiffSheet";

describe("activityTimeline — pure row model", () => {
  it("maps each tool kind to its verb-first row", () => {
    const cases: Array<{ trace: TimelineTraceInput; kind: string; verb: string }> = [
      {
        trace: { tool: "workspace_read_file", args: { path: "src/app.ts" }, durationMs: 42 },
        kind: "read",
        verb: "Read",
      },
      {
        trace: { tool: "host_read_file", args: { path: "C:\\repo\\README.md" }, durationMs: 15 },
        kind: "read",
        verb: "Read",
      },
      {
        trace: { tool: "grep_search", args: { query: "TraceItem" }, durationMs: 80 },
        kind: "search",
        verb: "Searched",
      },
      {
        trace: {
          tool: "workspace_write_file",
          args: { path: "src/app.ts", content: "const x = 1;\nconst y = 2;\n" },
          durationMs: 30,
        },
        kind: "write",
        verb: "Wrote",
      },
      {
        trace: { tool: "host_write_file", args: { path: "src/b.ts" }, durationMs: 25 },
        kind: "write",
        verb: "Wrote",
      },
      {
        trace: {
          tool: "workspace_run_command",
          args: { command: "npm run test:gate" },
          durationMs: 1200,
        },
        kind: "shell",
        verb: "Ran",
      },
      {
        trace: {
          tool: "host_run_powershell",
          args: { command: "git status" },
          durationMs: 300,
        },
        kind: "shell",
        verb: "Ran",
      },
      {
        trace: { tool: "fetch_web_page", args: { url: "https://example.com" }, durationMs: 410 },
        kind: "web",
        verb: "Fetched",
      },
      {
        trace: { tool: "search_web", args: { query: "node:test" }, durationMs: 520 },
        kind: "search",
        verb: "Searched",
      },
      {
        trace: { tool: "delegate_subagent", args: { task: "audit tests" }, durationMs: 3000 },
        kind: "subagent",
        verb: "Delegated",
      },
    ];

    for (const [idx, c] of cases.entries()) {
      assert.equal(classifyToolKind(c.trace.tool), c.kind, `kind for ${c.trace.tool}`);
      const row = traceToTimelineRow(c.trace, idx);
      assert.equal(row.verb, c.verb, `verb for ${c.trace.tool}`);
      assert.equal(row.status, "success");
    }
  });

  it("folds consecutive completed read rows into one expandable group row", () => {
    const traces: TimelineTraceInput[] = [
      { tool: "workspace_read_file", args: { path: "a.ts" }, durationMs: 10 },
      { tool: "workspace_read_file", args: { path: "b.ts" }, durationMs: 20 },
      { tool: "workspace_read_file", args: { path: "c.ts" }, durationMs: 30 },
      { tool: "workspace_write_file", args: { path: "d.ts" }, durationMs: 40 },
      { tool: "workspace_read_file", args: { path: "e.ts" }, durationMs: 15 },
    ];

    const rows = buildActivityTimeline(traces);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].isGroup, true);
    assert.equal(rows[0].label, "Read 3 files");
    assert.equal(rows[0].children?.length, 3);
    assert.equal(rows[0].durationMs, 60);
    assert.equal(rows[1].verb, "Wrote");
    assert.equal(rows[2].isGroup, undefined);
    assert.equal(rows[2].label, "Read e.ts");
  });

  it("folds consecutive completed search rows into one expandable group row", () => {
    const traces: TimelineTraceInput[] = [
      { tool: "grep_search", args: { query: "foo" }, durationMs: 50 },
      { tool: "search_web", args: { query: "bar" }, durationMs: 150 },
    ];

    const rows = buildActivityTimeline(traces);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isGroup, true);
    assert.equal(rows[0].label, "Searched 2 queries");
    assert.equal(rows[0].children?.length, 2);
    assert.equal(rows[0].durationMs, 200);
  });

  it("renders a failed trace as an error row with inline error summary and does not fold it", () => {
    const traces: TimelineTraceInput[] = [
      { tool: "workspace_read_file", args: { path: "a.ts" }, durationMs: 10 },
      {
        tool: "workspace_read_file",
        args: { path: "missing.ts" },
        durationMs: 12,
        result: { error: "ENOENT: no such file or directory, open 'missing.ts'" },
      },
      {
        tool: "workspace_run_command",
        args: { command: "npm test" },
        durationMs: 500,
        isError: true,
        result: "Exit code 1: 2 tests failed",
      },
    ];

    const rows = buildActivityTimeline(traces);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].status, "error");
    assert.ok(rows[1].errorSummary?.includes("ENOENT"));
    assert.equal(rows[2].status, "error");
    assert.ok(rows[2].errorSummary?.includes("Exit code 1"));
  });

  it("renders a running trace in present tense with live elapsed duration", () => {
    const startedAt = "2026-11-22T09:00:00.000Z";
    const nowMs = Date.parse("2026-11-22T09:00:04.200Z");
    const row = traceToTimelineRow(
      {
        tool: "workspace_run_command",
        args: { command: "npm run test:gate" },
        status: "running",
        timestamp: startedAt,
      },
      0,
      nowMs
    );

    assert.equal(row.status, "running");
    assert.equal(row.verb, "Running");
    assert.ok(row.label.startsWith("Running "));
    assert.equal(row.durationMs, 4200);
  });

  it("extracts write diff stats and unified diff text when present in trace payloads", () => {
    const diffText = "@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;";
    const row = traceToTimelineRow(
      {
        tool: "workspace_write_file",
        args: { path: "web-ui/lib/foo.ts" },
        result: { diff: diffText, addedLines: 2, removedLines: 1 },
        durationMs: 55,
      },
      0
    );

    assert.ok(row.writeDiff);
    assert.equal(row.writeDiff.filePath, "web-ui/lib/foo.ts");
    assert.equal(row.writeDiff.addedLines, 2);
    assert.equal(row.writeDiff.removedLines, 1);
    assert.equal(row.writeDiff.diffText, diffText);
  });

  it("does not fold running rows into preceding completed reads", () => {
    const rows = foldTimelineRows([
      traceToTimelineRow(
        { tool: "workspace_read_file", args: { path: "a.ts" }, durationMs: 10 },
        0
      ),
      traceToTimelineRow(
        { tool: "workspace_read_file", args: { path: "b.ts" }, status: "running" },
        1
      ),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].isGroup, undefined);
    assert.equal(rows[1].status, "running");
  });

  it("folds consecutive completed shell rows of 3 or more into one expandable group row", () => {
    const traces: TimelineTraceInput[] = [
      { tool: "host_run_powershell", args: { command: "git status" }, durationMs: 100 },
      { tool: "host_run_powershell", args: { command: "git diff" }, durationMs: 150 },
      { tool: "workspace_run_command", args: { command: "npm test" }, durationMs: 250 },
      { tool: "host_run_powershell", args: { command: "git log -1" }, durationMs: 50 },
      { tool: "host_run_powershell", args: { command: "ls" }, durationMs: 50 },
    ];

    const rows = buildActivityTimeline(traces);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isGroup, true);
    assert.equal(rows[0].kind, "shell");
    assert.equal(rows[0].verb, "Ran");
    assert.equal(rows[0].label, "Ran 5 commands");
    assert.equal(rows[0].children?.length, 5);
    assert.equal(rows[0].durationMs, 600);
    assert.equal(rows[0].children?.[0].target, "git status");
    assert.equal(rows[0].children?.[4].target, "ls");
  });

  it("does not fold a run of 1 or 2 shell rows", () => {
    const traces: TimelineTraceInput[] = [
      { tool: "host_run_powershell", args: { command: "git status" }, durationMs: 100 },
      { tool: "host_run_powershell", args: { command: "git diff" }, durationMs: 150 },
    ];

    const rows = buildActivityTimeline(traces);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].isGroup, undefined);
    assert.equal(rows[1].isGroup, undefined);
    assert.equal(rows[0].label, "Ran git status");
    assert.equal(rows[1].label, "Ran git diff");
  });

  it("breaks shell folding on an error row and keeps the error row unfolded", () => {
    const traces: TimelineTraceInput[] = [
      { tool: "host_run_powershell", args: { command: "cmd1" }, durationMs: 10 },
      { tool: "host_run_powershell", args: { command: "cmd2" }, durationMs: 10 },
      { tool: "host_run_powershell", args: { command: "cmd3" }, durationMs: 10 },
      {
        tool: "host_run_powershell",
        args: { command: "cmd4" },
        durationMs: 20,
        isError: true,
        result: "Exit code 1: boom",
      },
      { tool: "host_run_powershell", args: { command: "cmd5" }, durationMs: 10 },
      { tool: "host_run_powershell", args: { command: "cmd6" }, durationMs: 10 },
    ];

    const rows = buildActivityTimeline(traces);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].isGroup, true);
    assert.equal(rows[0].label, "Ran 3 commands");
    assert.equal(rows[0].children?.length, 3);
    assert.equal(rows[1].status, "error");
    assert.equal(rows[1].isGroup, undefined);
    assert.ok(rows[1].errorSummary?.includes("Exit code 1"));
    assert.equal(rows[2].isGroup, undefined);
    assert.equal(rows[2].label, "Ran cmd5");
    assert.equal(rows[3].isGroup, undefined);
    assert.equal(rows[3].label, "Ran cmd6");
  });

  it("strips leading PowerShell boilerplate and Set-Location from shell command targets", () => {
    const withPreamble = traceToTimelineRow(
      {
        tool: "host_run_powershell",
        args: {
          command:
            "$ErrorActionPreference='Continue'; $f='C:\\Users\\zackm\\Desktop\\repo\\testGate.ts'; Set-Location 'C:\\Users\\zackm\\Desktop\\repo'; Get-Content 'C:\\repo\\testGate.ts'",
        },
        durationMs: 120,
      },
      0
    );
    assert.equal(withPreamble.target, "Get-Content 'C:\\repo\\testGate.ts'");
    assert.equal(withPreamble.label, "Ran Get-Content 'C:\\repo\\testGate.ts'");

    const withDoubleQuotes = traceToTimelineRow(
      {
        tool: "host_run_powershell",
        args: {
          command: '$ErrorActionPreference = "Continue"; $dir="web-ui"; Set-Location "C:\\repo"; npm run test:gate',
        },
        durationMs: 80,
      },
      1
    );
    assert.equal(withDoubleQuotes.target, "npm run test:gate");
    assert.equal(withDoubleQuotes.label, "Ran npm run test:gate");

    const plain = traceToTimelineRow(
      {
        tool: "workspace_run_command",
        args: { command: "npm run test:gate" },
        durationMs: 50,
      },
      2
    );
    assert.equal(plain.target, "npm run test:gate");
    assert.equal(plain.label, "Ran npm run test:gate");

    const preambleOnly = traceToTimelineRow(
      {
        tool: "host_run_powershell",
        args: { command: "$ErrorActionPreference='Continue'; $f='a.ts';" },
        durationMs: 10,
      },
      3
    );
    assert.equal(preambleOnly.target, "$ErrorActionPreference='Continue'; $f='a.ts';");
    assert.equal(preambleOnly.label, "Ran $ErrorActionPreference='Continue'; $f='a.ts';");
  });

  it("synthesizes unified diff text for creation writes with full content and no recorded diff", () => {
    const content = "import { test } from '@playwright/test';\n\ntest('works', () => {});";
    const row = traceToTimelineRow(
      {
        tool: "workspace_write_file",
        args: { path: "web-ui/tests/e2e/settingsMobile.spec.ts", content },
        durationMs: 40,
      },
      0
    );

    assert.ok(row.writeDiff);
    assert.equal(row.writeDiff.synthesized, true);
    assert.equal(row.writeDiff.addedLines, 3);
    assert.equal(row.writeDiff.removedLines, 0);
    assert.ok(row.writeDiff.diffText);

    const parsed = parseUnifiedDiffWithLineNumbers(row.writeDiff.diffText);
    const added = parsed.filter((l) => l.kind === "add");
    assert.equal(added.length, 3);
    assert.equal(added[0].text, "+import { test } from '@playwright/test';");
    assert.equal(added[1].text, "+");
    assert.equal(added[2].text, "+test('works', () => {});");
  });

  it("does not synthesize diff text for replacement-only edits and leaves real diffs untouched", () => {
    const editRow = traceToTimelineRow(
      {
        tool: "replace_in_file",
        args: { path: "src/app.ts", replacement: "const x = 2;" },
        durationMs: 25,
      },
      0
    );
    assert.ok(editRow.writeDiff);
    assert.equal(editRow.writeDiff.diffText, undefined);
    assert.equal(editRow.writeDiff.synthesized, undefined);

    const realDiff = "@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;";
    const realRow = traceToTimelineRow(
      {
        tool: "workspace_write_file",
        args: { path: "src/app.ts", content: "const a = 1;\nconst b = 2;" },
        result: { diff: realDiff, addedLines: 1, removedLines: 0 },
        durationMs: 25,
      },
      1
    );
    assert.ok(realRow.writeDiff);
    assert.equal(realRow.writeDiff.diffText, realDiff);
    assert.equal(realRow.writeDiff.synthesized, undefined);
  });
});
