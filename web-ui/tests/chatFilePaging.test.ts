import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TOOL_OUTPUT_CHARS,
  clampToolOutput
} from "../lib/contextBudget";
import {
  DEFAULT_TOOL_SCHEMAS,
  KNOWN_ONE_LINERS
} from "../lib/progressiveTools";
import { HOST_TOOLS_DEFINITIONS } from "../lib/hostMode";

describe("Chat-2: File Reads & Pagination Parity Suite", () => {
  describe("Context Budget & Tool Output Clamping", () => {
    it("MAX_TOOL_OUTPUT_CHARS is set to 64000", () => {
      assert.equal(MAX_TOOL_OUTPUT_CHARS, 64000);
    });

    it("clampToolOutput does not truncate content <= 64000 chars", () => {
      const shortStr = "Small output text within budget";
      assert.equal(clampToolOutput(shortStr), shortStr);

      const exactStr = "x".repeat(64000);
      assert.equal(clampToolOutput(exactStr), exactStr);
      assert.equal(clampToolOutput(exactStr).length, 64000);
    });

    it("clampToolOutput truncates content > 64000 chars, appends TRUNCATED metadata, and resulting length <= 64000", () => {
      const totalChars = 75000;
      const raw = "A".repeat(totalChars);
      const clamped = clampToolOutput(raw);

      assert.ok(clamped.length <= 64000, `Expected clamped length <= 64000, got ${clamped.length}`);
      assert.equal(clamped.length, 64000, `Expected clamped length to be exactly 64000`);

      const expectedMarker = `\n...[TRUNCATED: Output was ${totalChars} chars, showing first 64000 chars. Use start_line/end_line or offset/limit to read remaining chunks.]`;
      assert.ok(
        clamped.endsWith(expectedMarker),
        `Expected clamped output to end with structured metadata marker. Ended with: ${clamped.slice(-150)}`
      );
      assert.ok(
        clamped.startsWith("A".repeat(64000 - expectedMarker.length)),
        "Expected clamped output to retain the beginning slice of content"
      );
    });

    it("clampToolOutput handles custom maxChars override correctly", () => {
      const totalChars = 1000;
      const raw = "B".repeat(totalChars);
      const clamped = clampToolOutput(raw, 500);

      assert.ok(clamped.length <= 500);
      assert.equal(clamped.length, 500);
      assert.ok(clamped.includes("[TRUNCATED: Output was 1000 chars, showing first 500 chars"));
    });
  });

  describe("Schema Parity: workspace_read_file vs host_read_file", () => {
    it("KNOWN_ONE_LINERS.workspace_read_file declares pagination parameters", () => {
      assert.equal(
        KNOWN_ONE_LINERS.workspace_read_file,
        "workspace_read_file(path, start_line?, end_line?, offset?, limit?): Read file contents with line numbers and pagination."
      );
    });

    it("DEFAULT_TOOL_SCHEMAS.workspace_read_file and host_read_file have parameter parity", () => {
      const wsSchema = DEFAULT_TOOL_SCHEMAS.workspace_read_file;
      assert.ok(wsSchema, "workspace_read_file schema must be defined in DEFAULT_TOOL_SCHEMAS");

      const hostTool = HOST_TOOLS_DEFINITIONS.find((t: any) => t.function?.name === "host_read_file");
      assert.ok(hostTool, "host_read_file must be defined in HOST_TOOLS_DEFINITIONS");
      const hostSchema = hostTool.function;

      const wsParams = (wsSchema.parameters as any)?.properties || {};
      const hostParams = (hostSchema.parameters as any)?.properties || {};

      // Required parameter
      assert.deepEqual((wsSchema.parameters as any)?.required, ["path"]);
      assert.deepEqual((hostSchema.parameters as any)?.required, ["path"]);

      // Parameter keys parity
      const expectedKeys = ["path", "start_line", "end_line", "offset", "limit"].sort();
      assert.deepEqual(Object.keys(wsParams).sort(), expectedKeys);
      assert.deepEqual(Object.keys(hostParams).sort(), expectedKeys);

      // Parameter types parity
      assert.equal(wsParams.path?.type, "string");
      assert.equal(hostParams.path?.type, "string");

      assert.equal(wsParams.start_line?.type, "number");
      assert.equal(hostParams.start_line?.type, "number");

      assert.equal(wsParams.end_line?.type, "number");
      assert.equal(hostParams.end_line?.type, "number");

      assert.equal(wsParams.offset?.type, "number");
      assert.equal(hostParams.offset?.type, "number");

      assert.equal(wsParams.limit?.type, "number");
      assert.equal(hostParams.limit?.type, "number");
    });
  });

  describe("Line Slicing Calculation Parity (start_line/end_line & offset/limit)", () => {
    function calculateSlice(
      allLinesCount: number,
      args: { start_line?: number; end_line?: number; offset?: number; limit?: number }
    ) {
      const { start_line, end_line, offset, limit } = args;
      const start = start_line ? Math.max(1, start_line) : (offset !== undefined ? Math.max(1, offset === 0 ? 1 : offset) : 1);
      const end = end_line ? Math.min(allLinesCount, end_line) : (limit !== undefined ? Math.min(allLinesCount, start + limit - 1) : allLinesCount);
      return {
        start,
        end,
        showing_lines: `${start}-${end}`,
        has_more: end < allLinesCount,
        next_start_line: end < allLinesCount ? end + 1 : null
      };
    }

    it("defaults to whole file when no range parameters provided", () => {
      const res = calculateSlice(100, {});
      assert.equal(res.start, 1);
      assert.equal(res.end, 100);
      assert.equal(res.showing_lines, "1-100");
      assert.equal(res.has_more, false);
      assert.equal(res.next_start_line, null);
    });

    it("slices correctly with start_line and end_line", () => {
      const res = calculateSlice(100, { start_line: 10, end_line: 25 });
      assert.equal(res.start, 10);
      assert.equal(res.end, 25);
      assert.equal(res.showing_lines, "10-25");
      assert.equal(res.has_more, true);
      assert.equal(res.next_start_line, 26);
    });

    it("slices correctly with offset and limit", () => {
      const res = calculateSlice(100, { offset: 15, limit: 10 });
      assert.equal(res.start, 15);
      assert.equal(res.end, 24);
      assert.equal(res.showing_lines, "15-24");
      assert.equal(res.has_more, true);
      assert.equal(res.next_start_line, 25);
    });

    it("handles offset: 0 by normalising to 1", () => {
      const res = calculateSlice(100, { offset: 0, limit: 20 });
      assert.equal(res.start, 1);
      assert.equal(res.end, 20);
      assert.equal(res.showing_lines, "1-20");
      assert.equal(res.has_more, true);
      assert.equal(res.next_start_line, 21);
    });

    it("clamps start_line below 1 to 1", () => {
      const res = calculateSlice(50, { start_line: -10, end_line: 15 });
      assert.equal(res.start, 1);
      assert.equal(res.end, 15);
      assert.equal(res.has_more, true);
      assert.equal(res.next_start_line, 16);
    });

    it("clamps end_line and limit beyond file length to file length", () => {
      const res1 = calculateSlice(30, { start_line: 20, end_line: 100 });
      assert.equal(res1.start, 20);
      assert.equal(res1.end, 30);
      assert.equal(res1.has_more, false);
      assert.equal(res1.next_start_line, null);

      const res2 = calculateSlice(30, { offset: 25, limit: 20 });
      assert.equal(res2.start, 25);
      assert.equal(res2.end, 30);
      assert.equal(res2.has_more, false);
      assert.equal(res2.next_start_line, null);
    });

    it("prefers start_line over offset and end_line over limit", () => {
      const res = calculateSlice(100, {
        start_line: 12,
        offset: 50,
        end_line: 30,
        limit: 5
      });
      assert.equal(res.start, 12);
      assert.equal(res.end, 30);
      assert.equal(res.showing_lines, "12-30");
    });
  });
});
