import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseUnifiedDiffWithLineNumbers } from "../components/CanvasDiffSheet";

describe("CanvasDiffSheet — unified diff line numbers & guards", () => {
  it("parses unified diff hunks with accurate old and new line numbers", () => {
    const diff = [
      "@@ -10,4 +10,5 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ].join("\n");

    const lines = parseUnifiedDiffWithLineNumbers(diff);
    assert.equal(lines.length, 6);
    assert.equal(lines[0].kind, "hunk");
    assert.deepEqual(lines[1], { kind: "ctx", oldLine: 10, newLine: 10, text: " const a = 1;" });
    assert.deepEqual(lines[2], { kind: "del", oldLine: 11, newLine: null, text: "-const b = 2;" });
    assert.deepEqual(lines[3], { kind: "add", oldLine: null, newLine: 11, text: "+const b = 3;" });
    assert.deepEqual(lines[4], { kind: "add", oldLine: null, newLine: 12, text: "+const c = 4;" });
    assert.deepEqual(lines[5], { kind: "ctx", oldLine: 12, newLine: 13, text: " const d = 5;" });
  });

  it("guard: CanvasDiffSheet.tsx never uses banned zinc-500 text classes", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../components/CanvasDiffSheet.tsx"),
      "utf8"
    );
    assert.equal(/\btext-zinc-500\b/.test(src), false);
  });
});
