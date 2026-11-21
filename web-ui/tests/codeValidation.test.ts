import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCodeAst, normalizeErrorSignature } from "../lib/subagents/workerPool.js";

describe("subagents/codeValidation characterization", () => {
  describe("validateCodeAst", () => {
    it("accepts valid TypeScript, TSX, and JavaScript", () => {
      assert.deepEqual(validateCodeAst("src/app.ts", "export const x: number = 42;"), {
        valid: true,
      });
      assert.deepEqual(validateCodeAst("src/View.tsx", "export const View = () => <div />;"), {
        valid: true,
      });
      assert.deepEqual(validateCodeAst("src/util.js", "export function add(a, b) { return a + b; }"), {
        valid: true,
      });
    });

    it("rejects invalid TypeScript syntax with line and column", () => {
      const res = validateCodeAst("src/broken.ts", "export const = ;");
      assert.equal(res.valid, false);
      assert.ok(res.error?.includes("Syntax error in src/broken.ts [line 1,"));
    });

    it("validates JSON files", () => {
      assert.deepEqual(validateCodeAst("config.json", '{"ok": true}'), { valid: true });
      const bad = validateCodeAst("config.json", "{ bad json");
      assert.equal(bad.valid, false);
      assert.ok(bad.error?.includes("Invalid JSON syntax in config.json"));
    });

    it("validates SVG, XML, and drawio files", () => {
      assert.deepEqual(validateCodeAst("diagram.svg", "<svg><rect /></svg>"), { valid: true });
      const badSvg = validateCodeAst("diagram.svg", "<svg><rect />");
      assert.equal(badSvg.valid, false);
      assert.ok(badSvg.error?.includes("Invalid SVG format"));

      assert.deepEqual(validateCodeAst("arch.drawio", "<mxfile></mxfile>"), { valid: true });
      const badXml = validateCodeAst("arch.xml", "not xml at all");
      assert.equal(badXml.valid, false);
      assert.ok(badXml.error?.includes("Invalid XML format"));
    });

    it("passes through non-code files", () => {
      assert.deepEqual(validateCodeAst("README.md", "# Title\nAnything goes"), { valid: true });
    });
  });

  describe("normalizeErrorSignature", () => {
    it("normalizes file basename, line number, and error type", () => {
      assert.equal(
        normalizeErrorSignature(
          "web-ui/lib/MyFile.ts",
          "Syntax error in MyFile.ts [line 12, col 4]: Unexpected token"
        ),
        "myfile.ts:12:syntax_error"
      );
      assert.equal(
        normalizeErrorSignature("src/Index.TS", "TypeError at (45:2): cannot read property"),
        "index.ts:45:typeerror"
      );
      assert.equal(
        normalizeErrorSignature("a/b/c.js", "unrecognized failure without line"),
        "c.js:unknown:syntax_error"
      );
    });
  });
});
