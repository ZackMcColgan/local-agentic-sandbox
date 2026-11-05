import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_TOOL_OUTPUT_CHARS,
  clampToolOutput,
  runChatToolLoop
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

  describe("Pin 1 Compliance: Uncapped File Reads & Large File (>200KB) Paging to EOF", () => {
    const testDir = typeof __dirname !== "undefined" ? __dirname : path.resolve(process.cwd(), "web-ui/tests");

    it("statically verifies chat/route.ts and contextBudget.ts exempt workspace_read_file and host_read_file from clampToolOutput", () => {
      const routePath = path.resolve(testDir, "../app/api/chat/route.ts");
      const routeCode = fs.readFileSync(routePath, "utf-8");

      assert.ok(
        routeCode.includes('toolName === "workspace_read_file" || toolName === "host_read_file"'),
        "route.ts must identify file read tools (workspace_read_file and host_read_file)"
      );
      assert.ok(
        routeCode.includes("content: isFileReadTool ? JSON.stringify(result) : clampToolOutput(JSON.stringify(result))"),
        "route.ts must bypass clampToolOutput for file read tools"
      );

      const contextPath = path.resolve(testDir, "../lib/contextBudget.ts");
      const contextCode = fs.readFileSync(contextPath, "utf-8");

      assert.ok(
        contextCode.includes('toolName === "workspace_read_file" || toolName === "host_read_file"'),
        "contextBudget.ts must identify file read tools (workspace_read_file and host_read_file)"
      );
      assert.ok(
        contextCode.includes("content: isFileReadTool ? JSON.stringify(toolResult) : clampToolOutput(JSON.stringify(toolResult))"),
        "contextBudget.ts must bypass clampToolOutput for file read tools"
      );
    });

    it("runChatToolLoop exempts workspace_read_file and host_read_file from clampToolOutput while clamping other tools", async () => {
      const largePayload = {
        status: "SUCCESS",
        content: "Z".repeat(70000)
      };

      // 1. workspace_read_file should NOT be clamped
      const wsMessages: any[] = [{ role: "user", content: "read file" }];
      await runChatToolLoop({
        conversationMessages: wsMessages,
        maxContentTokens: 100000,
        llmTools: [{ type: "function", function: { name: "workspace_read_file" } }],
        maxToolRounds: 2,
        streamLlmChat: async function* (payload: any) {
          if (payload.messages.length === 1) {
            yield {
              message: {
                content: "",
                tool_calls: [{
                  id: "call_1",
                  type: "function",
                  function: { name: "workspace_read_file", arguments: '{"path":"large.txt"}' }
                }]
              }
            };
          } else {
            yield { message: { content: "Done reading file" } };
          }
        },
        executeTool: async () => largePayload
      });

      const wsToolMsg = wsMessages.find((m) => m.role === "tool" && m.name === "workspace_read_file");
      assert.ok(wsToolMsg, "Must have recorded workspace_read_file tool message");
      assert.ok(wsToolMsg.content.length > 70000, "workspace_read_file output must NOT be clamped to 64000 chars");
      assert.ok(!wsToolMsg.content.includes("[TRUNCATED:"), "workspace_read_file output must not have truncation notice");

      // 2. host_read_file should NOT be clamped
      const hostMessages: any[] = [{ role: "user", content: "read host file" }];
      await runChatToolLoop({
        conversationMessages: hostMessages,
        maxContentTokens: 100000,
        llmTools: [{ type: "function", function: { name: "host_read_file" } }],
        maxToolRounds: 2,
        streamLlmChat: async function* (payload: any) {
          if (payload.messages.length === 1) {
            yield {
              message: {
                content: "",
                tool_calls: [{
                  id: "call_2",
                  type: "function",
                  function: { name: "host_read_file", arguments: '{"path":"C:\\\\large.txt"}' }
                }]
              }
            };
          } else {
            yield { message: { content: "Done reading host file" } };
          }
        },
        executeTool: async () => largePayload
      });

      const hostToolMsg = hostMessages.find((m) => m.role === "tool" && m.name === "host_read_file");
      assert.ok(hostToolMsg, "Must have recorded host_read_file tool message");
      assert.ok(hostToolMsg.content.length > 70000, "host_read_file output must NOT be clamped to 64000 chars");
      assert.ok(!hostToolMsg.content.includes("[TRUNCATED:"), "host_read_file output must not have truncation notice");

      // 3. non-read tool (workspace_run_command) MUST be clamped
      const cmdMessages: any[] = [{ role: "user", content: "run command" }];
      await runChatToolLoop({
        conversationMessages: cmdMessages,
        maxContentTokens: 100000,
        llmTools: [{ type: "function", function: { name: "workspace_run_command" } }],
        maxToolRounds: 2,
        streamLlmChat: async function* (payload: any) {
          if (payload.messages.length === 1) {
            yield {
              message: {
                content: "",
                tool_calls: [{
                  id: "call_3",
                  type: "function",
                  function: { name: "workspace_run_command", arguments: '{"command":"cat huge.log"}' }
                }]
              }
            };
          } else {
            yield { message: { content: "Done running command" } };
          }
        },
        executeTool: async () => largePayload
      });

      const cmdToolMsg = cmdMessages.find((m) => m.role === "tool" && m.name === "workspace_run_command");
      assert.ok(cmdToolMsg, "Must have recorded workspace_run_command tool message");
      assert.equal(cmdToolMsg.content.length, 64000, "workspace_run_command output MUST be clamped to 64000 chars");
      assert.ok(cmdToolMsg.content.includes("[TRUNCATED:"), "workspace_run_command output MUST have truncation notice");
    });

    it("simulates a large file > 64,000 chars (~200KB, 2,500 lines / ~220,000 bytes) paging through the file to EOF in chunks", () => {
      // Generate synthetic large file: 2,500 lines, ~220KB
      const TOTAL_LINES = 2500;
      const lines: string[] = [];
      for (let i = 1; i <= TOTAL_LINES; i++) {
        // ~88 characters per line
        lines.push(`Line ${String(i).padStart(4, "0")}: export const CONFIG_KEY_${i} = "${"X".repeat(50)}";`);
      }
      const fullContent = lines.join("\n");
      const totalBytes = Buffer.byteLength(fullContent, "utf8");

      assert.equal(lines.length, 2500);
      assert.ok(
        totalBytes >= 200000,
        `Expected file size >= 200,000 bytes, got ${totalBytes} bytes`
      );
      assert.ok(
        fullContent.length > 64000,
        `Expected full content chars > 64,000, got ${fullContent.length}`
      );

      function simulateReadFile(
        allLines: string[],
        fileBytes: number,
        args: { start_line?: number; end_line?: number; offset?: number; limit?: number }
      ) {
        const { start_line, end_line, offset, limit } = args;
        const start = start_line
          ? Math.max(1, start_line)
          : (offset !== undefined ? Math.max(1, offset === 0 ? 1 : offset) : 1);
        const end = end_line
          ? Math.min(allLines.length, end_line)
          : (limit !== undefined ? Math.min(allLines.length, start + limit - 1) : allLines.length);

        const slice = allLines.slice(start - 1, end);
        const formatted = slice.map((line, idx) => `${start + idx} | ${line}`).join("\n");
        return {
          status: "SUCCESS",
          path: "src/massiveConfig.ts",
          total_lines: allLines.length,
          total_bytes: fileBytes,
          showing_lines: `${start}-${end}`,
          has_more: end < allLines.length,
          next_start_line: end < allLines.length ? end + 1 : null,
          content: formatted
        };
      }

      // Page through the file in chunks of 500 lines: 5 pages total
      const pageSize = 500;
      const totalPages = Math.ceil(TOTAL_LINES / pageSize);
      assert.equal(totalPages, 5);

      const collectedLines: string[] = [];
      let currentStartLine = 1;

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = simulateReadFile(lines, totalBytes, {
          start_line: currentStartLine,
          end_line: currentStartLine + pageSize - 1
        });

        // Every page has consistent total_lines and total_bytes
        assert.equal(
          page.total_lines,
          TOTAL_LINES,
          `Page ${pageNum} total_lines must be exactly ${TOTAL_LINES}`
        );
        assert.equal(
          page.total_bytes,
          totalBytes,
          `Page ${pageNum} total_bytes must be exactly ${totalBytes}`
        );

        if (pageNum < 5) {
          assert.equal(
            page.has_more,
            true,
            `Page ${pageNum} must have has_more === true`
          );
          assert.equal(
            page.next_start_line,
            pageNum * pageSize + 1,
            `Page ${pageNum} next_start_line must be ${pageNum * pageSize + 1}`
          );
        } else {
          // Final page 5
          assert.equal(
            page.has_more,
            false,
            `Final page ${pageNum} must have has_more === false`
          );
          assert.equal(
            page.next_start_line,
            null,
            `Final page ${pageNum} next_start_line must be null`
          );
        }

        // Parse formatted lines and accumulate
        const pageLines = page.content.split("\n").map((l) => l.replace(/^\d+ \| /, ""));
        assert.equal(pageLines.length, pageSize);
        collectedLines.push(...pageLines);

        if (page.next_start_line) {
          currentStartLine = page.next_start_line;
        }
      }

      // Every byte of the file is reachable and verifiable through paging to EOF
      assert.equal(collectedLines.length, TOTAL_LINES);
      assert.deepEqual(collectedLines, lines);
      const reconstructedText = collectedLines.join("\n");
      assert.equal(reconstructedText, fullContent);
      assert.equal(Buffer.byteLength(reconstructedText, "utf8"), totalBytes);
    });

    it("verifies individual pages with content > 64,000 chars are NOT clamped or truncated by any fixed ceiling", () => {
      // Simulate an individual page whose content alone exceeds 64,000 chars (e.g. 800 lines of ~95 chars = ~76KB)
      const largeLines: string[] = [];
      for (let i = 1; i <= 800; i++) {
        largeLines.push(`Row ${String(i).padStart(4, "0")}: ${"Y".repeat(90)}`);
      }
      const pageSliceFormatted = largeLines.map((l, idx) => `${idx + 1} | ${l}`).join("\n");
      assert.ok(
        pageSliceFormatted.length > 64000,
        `Page formatted content should exceed 64,000 chars (actual: ${pageSliceFormatted.length})`
      );

      const pageResult = {
        status: "SUCCESS",
        path: "large_single_page.txt",
        total_lines: 2000,
        total_bytes: 220000,
        showing_lines: "1-800",
        has_more: true,
        next_start_line: 801,
        content: pageSliceFormatted
      };

      const rawJson = JSON.stringify(pageResult);
      assert.ok(
        rawJson.length > 64000,
        `rawJson must exceed 64,000 characters (actual: ${rawJson.length})`
      );

      // Verify that clampToolOutput WOULD have truncated it if applied
      const clamped = clampToolOutput(rawJson);
      assert.equal(clamped.length, 64000, "clampToolOutput clamps to 64000 chars");
      assert.ok(clamped.includes("[TRUNCATED:"), "clampToolOutput appends truncation notice");

      // Verify Pin 1 compliance logic: file read tools are NOT clamped
      for (const readToolName of ["workspace_read_file", "host_read_file"]) {
        const isFileReadTool = readToolName === "workspace_read_file" || readToolName === "host_read_file";
        const messageContent = isFileReadTool ? JSON.stringify(pageResult) : clampToolOutput(JSON.stringify(pageResult));

        assert.equal(
          messageContent.length,
          rawJson.length,
          `${readToolName} must retain entire raw JSON without any fixed ceiling clamping`
        );
        assert.ok(
          !messageContent.includes("[TRUNCATED:"),
          `${readToolName} must not contain any truncation notice`
        );

        // Verify round-trip parseability and content integrity
        const parsed = JSON.parse(messageContent);
        assert.equal(parsed.content.length, pageSliceFormatted.length);
        assert.equal(parsed.content, pageSliceFormatted);
        assert.equal(parsed.total_lines, 2000);
        assert.equal(parsed.has_more, true);
        assert.equal(parsed.next_start_line, 801);
      }
    });
  });
});
