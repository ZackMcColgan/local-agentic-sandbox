import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { resolveSafePath } from "../../mcp-server/src/tools/workspaceTools.js";
import {
  extractSvgsFromMessage,
  extractCodeDeliverablesFromMessage,
  hasCompleteInlineSvg
} from "../lib/svgUtils.js";

describe("Artifact Delivery and UI Polish Suite", () => {
  describe("Task 1: resolveSafePath in mcp-server workspaceTools", () => {
    it("resolves raw paths, workspace/ prefixed paths, and /workspace/ paths to the exact same path", () => {
      const p1 = resolveSafePath("weather.svg");
      const p2 = resolveSafePath("workspace/weather.svg");
      const p3 = resolveSafePath("/workspace/weather.svg");
      const p4 = resolveSafePath("workspace\\weather.svg");

      assert.equal(p1, p2, "workspace/weather.svg must resolve identical to weather.svg");
      assert.equal(p1, p3, "/workspace/weather.svg must resolve identical to weather.svg");
      assert.equal(p1, p4, "workspace\\weather.svg must resolve identical to weather.svg");
      assert.ok(!p2.includes("workspace" + path.sep + "workspace"), "Must not double workspace directory");
    });

    it("rejects path traversal attempts outside workspace", () => {
      assert.throws(
        () => resolveSafePath("../secret.txt"),
        /Security Violation: Path traversal outside \/workspace is forbidden/
      );
      assert.throws(
        () => resolveSafePath("/../etc/passwd"),
        /Security Violation: Path traversal outside \/workspace is forbidden/
      );
    });
  });

  describe("Task 2: extractSvgsFromMessage & extractCodeDeliverablesFromMessage in svgUtils", () => {
    it("extracts SVG from workspace_write_file even when message.content contains prose mentioning '<svg'", () => {
      const message = {
        id: "msg-1",
        content: "I created an <svg> element in weather.svg for you.",
        traces: [
          {
            tool: "workspace_write_file",
            args: {
              path: "workspace/weather.svg",
              content: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'
            },
            result: { status: "SUCCESS" }
          }
        ]
      };

      const svgs = extractSvgsFromMessage(message);
      assert.equal(svgs.length, 1, "Must extract the tool-generated SVG");
      assert.equal(svgs[0].title, "weather.svg");
      assert.ok(svgs[0].code?.includes("<svg"), "Must preserve SVG markup");
    });

    it("hasCompleteInlineSvg accurately identifies complete SVGs and Draw.io blocks vs prose mentions", () => {
      assert.equal(hasCompleteInlineSvg("I wrote the <svg> tag into file.svg"), false);
      assert.equal(hasCompleteInlineSvg("```svg\n<svg viewBox=\"0 0 10 10\"></svg>\n```"), true);
      assert.equal(hasCompleteInlineSvg("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg>"), true);
      assert.equal(hasCompleteInlineSvg("<mxfile><diagram>abc</diagram></mxfile>"), true);
    });

    it("infers SVG path from execute_sandboxed_python code writing an SVG file", () => {
      const message = {
        id: "msg-py",
        content: "Generated chart in python.",
        traces: [
          {
            tool: "execute_sandboxed_python",
            args: {
              code: 'with open("spanish_fort.svg", "w") as f:\n    f.write("<svg></svg>")'
            },
            result: { content: [{ text: "Successfully executed python script" }] }
          }
        ]
      };

      const svgs = extractSvgsFromMessage(message);
      assert.equal(svgs.length, 1, "Must extract inferred SVG from python code write");
      assert.equal(svgs[0].title, "spanish_fort.svg");
      assert.equal(svgs[0].url, "/api/files?path=spanish_fort.svg");
    });

    it("extractCodeDeliverablesFromMessage extracts non-SVG files written via workspace_write_file", () => {
      const message = {
        id: "msg-code",
        content: "I have implemented the solution in app.py.",
        traces: [
          {
            tool: "workspace_write_file",
            args: {
              path: "app.py",
              content: "def main():\n    return 42\n"
            },
            result: { status: "SUCCESS" }
          }
        ]
      };

      const deliverables = extractCodeDeliverablesFromMessage(message);
      assert.equal(deliverables.length, 1, "Must extract 1 code deliverable");
      assert.equal(deliverables[0].title, "app.py");
      assert.equal(deliverables[0].language, "py");
      assert.equal(deliverables[0].code, "def main():\n    return 42\n");
      assert.equal(deliverables[0].url, "/api/files?path=app.py");
    });
  });

  describe("Task 3: ChatStream.tsx Delivery Wiring & Polish", () => {
    it("ChatStream.tsx does not use m.content.includes('<svg') as an SVG blocker and removes workerPool.ts:342", () => {
      const chatStreamPath = path.resolve(__dirname, "../components/ChatStream.tsx");
      assert.ok(fs.existsSync(chatStreamPath), "ChatStream.tsx must exist");
      const content = fs.readFileSync(chatStreamPath, "utf8");

      assert.ok(
        !content.includes('m.content.includes("<svg")'),
        "ChatStream.tsx must NOT contain m.content.includes('<svg') blocker"
      );
      assert.ok(
        !content.includes("workerPool.ts:342"),
        "ChatStream.tsx must NOT contain hardcoded workerPool.ts:342 fallback"
      );
      assert.ok(
        content.includes("extractCodeDeliverablesFromMessage"),
        "ChatStream.tsx must wire extractCodeDeliverablesFromMessage"
      );
      assert.ok(
        content.includes("hasCompleteInlineSvg"),
        "ChatStream.tsx must use hasCompleteInlineSvg"
      );
    });
  });

  describe("Task 4: Workspace Inspector Polish in web-ui/app/page.tsx", () => {
    const pagePath = path.resolve(__dirname, "../app/page.tsx");
    assert.ok(fs.existsSync(pagePath), "page.tsx must exist");
    const content = fs.readFileSync(pagePath, "utf8");

    it("only shows the 'Verified' badge when activeTask.status === 'completed'", () => {
      assert.doesNotMatch(
        content,
        /<div className="flex items-center gap-2">\s*<span className="font-bold text-sm[^"]*">Workspace<\/span>\s*<span className="badge badge-success[^"]*">\s*Verified\s*<\/span>/,
        "Verified badge must not be rendered unconditionally"
      );
      assert.match(
        content,
        /activeTask\?\.status\s*===\s*["']completed["']\s*&&\s*\([\s\S]*?Verified/,
        "Verified badge must be conditioned on activeTask?.status === 'completed'"
      );
    });

    it("reads m.diffSummary || m.diff in Diff tab and labels output tab 'Test Output'", () => {
      assert.match(
        content,
        /m\.diffSummary\s*\|\|\s*m\.diff/,
        "Diff tab must check m.diffSummary || m.diff"
      );
      assert.ok(
        content.includes("Test Output"),
        "Output tab must be labeled 'Test Output'"
      );
      assert.ok(
        !content.includes("Pytest Output"),
        "Output tab must NOT be labeled 'Pytest Output'"
      );
    });

    it("renders workspace files in Files tab as interactive buttons loading /api/files?path=", () => {
      assert.match(
        content,
        /\/api\/files\?path=/,
        "page.tsx must fetch /api/files?path= to preview selected workspace file"
      );
      assert.match(
        content,
        /<button[^>]*onClick=\{[^}]*handlePreviewWorkspaceFile/,
        "Files tab must render interactive buttons that call handlePreviewWorkspaceFile"
      );
      assert.ok(
        content.includes("No workspace files modified yet."),
        "Empty state must remain intact for punchlistUiFixes compatibility"
      );
    });
  });
});
