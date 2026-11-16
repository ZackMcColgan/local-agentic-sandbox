import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { workspacePatchFile } from "../lib/subagents/patchCore";
import { checkCommandDialect } from "../../host-bridge/dialectGuard";

describe("P2.2: Patch integrity & command-dialect guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `p22-patch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("CRLF-safe replaceString: preserves CRLF line endings when patched with LF search/replace", async () => {
    const filePath = path.join(tmpDir, "win.ts");
    fs.writeFileSync(filePath, "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n", "utf8");

    const res = await workspacePatchFile(tmpDir, "win.ts", [
      { search: "const a = 1;\nconst b = 2;", replace: "const a = 10;\nconst b = 20;" },
    ]);
    assert.equal(res.status, "SUCCESS");
    const updated = fs.readFileSync(filePath, "utf8");
    assert.equal(updated, "const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n");
  });

  it("$-literal handling: does not expand $&, $', or $1 in replacement", async () => {
    const filePath = path.join(tmpDir, "dollar.ts");
    fs.writeFileSync(filePath, "const price = 'PLACEHOLDER';\n", "utf8");

    const res = await workspacePatchFile(tmpDir, "dollar.ts", [
      { search: "'PLACEHOLDER'", replace: "'$1 $& $`'" },
    ]);
    assert.equal(res.status, "SUCCESS");
    const updated = fs.readFileSync(filePath, "utf8");
    assert.equal(updated, "const price = '$1 $& $`';\n");
  });

  it("AST gate: rejects patch that introduces TypeScript syntax errors without modifying disk", async () => {
    const filePath = path.join(tmpDir, "ast.ts");
    const original = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    fs.writeFileSync(filePath, original, "utf8");

    await assert.rejects(
      () =>
        workspacePatchFile(tmpDir, "ast.ts", [
          { search: "return a + b;", replace: "return a + ;;; ((" },
        ]),
      /AST|syntax/i
    );
    const onDisk = fs.readFileSync(filePath, "utf8");
    assert.equal(onDisk, original, "file on disk must remain untouched when AST gate rejects");
  });

  it("command-dialect guard: rejects bash-only syntax when target shell is powershell", () => {
    const bad = checkCommandDialect("export FOO=bar && grep -rn foo .", "powershell");
    assert.equal(bad.ok, false);
    assert.ok(bad.reason && bad.reason.length > 0, "must return corrective error reason");

    const good = checkCommandDialect("Get-ChildItem -Path .", "powershell");
    assert.equal(good.ok, true);
  });
});
