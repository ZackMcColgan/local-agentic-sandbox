import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  scanWorkspaceRepoMap,
  getResolvedGitSha,
  createUnifiedDiff,
  type WorkspaceRepoMap,
} from "../lib/subagents/workerPool.js";

describe("subagents/repoMap characterization", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe("scanWorkspaceRepoMap", () => {
    it("extracts TS/JS/Python symbols and ignores excluded directories", () => {
      const root = makeTempDir("repomap-scan-");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });

      fs.writeFileSync(
        path.join(root, "src", "alpha.ts"),
        [
          "export function greet() {}",
          "export class Greeter {}",
          "export interface Greeting { text: string; }",
          "export type GreetingId = string;",
          "export enum Tone { Warm }",
          "export const DEFAULT_TONE = Tone.Warm;",
          "const helper = 1;",
          "export { helper };",
        ].join("\n"),
        "utf8"
      );

      fs.writeFileSync(
        path.join(root, "src", "script.py"),
        ["class Worker:", "  pass", "def run_job():", "  pass", "async def fetch_data():", "  pass"].join("\n"),
        "utf8"
      );

      fs.writeFileSync(path.join(root, "src", "notes.md"), "# ignored", "utf8");
      fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.ts"), "export const x = 1;", "utf8");
      fs.writeFileSync(path.join(root, "dist", "bundle.js"), "export const y = 2;", "utf8");

      const map: WorkspaceRepoMap = scanWorkspaceRepoMap(root);
      assert.equal(map.root, root);
      assert.equal(map.length, 2);
      assert.equal(map.toString(), map.treeSummary);

      const alpha = map.files.find((f) => f.path === "src/alpha.ts");
      assert.ok(alpha, "should include src/alpha.ts");
      assert.deepEqual(alpha.exports, [
        "greet",
        "Greeter",
        "Greeting",
        "GreetingId",
        "Tone",
        "DEFAULT_TONE",
        "helper",
      ]);

      const py = map.files.find((f) => f.path === "src/script.py");
      assert.ok(py, "should include src/script.py");
      assert.deepEqual(py.exports, ["Worker", "run_job", "fetch_data"]);
      assert.ok(map.treeSummary.includes("src/alpha.ts: greet, Greeter"));
    });

    it("filters by query (path or symbol, case-insensitive) and respects maxFiles", () => {
      const root = makeTempDir("repomap-filter-");
      fs.writeFileSync(path.join(root, "a.ts"), "export function alphaFn() {}", "utf8");
      fs.writeFileSync(path.join(root, "b.ts"), "export function betaFn() {}", "utf8");
      fs.writeFileSync(path.join(root, "c.ts"), "export function gammaFn() {}", "utf8");

      const bySymbol = scanWorkspaceRepoMap(root, { query: "BETAFN" });
      assert.equal(bySymbol.length, 1);
      assert.equal(bySymbol.files[0].path, "b.ts");

      const capped = scanWorkspaceRepoMap(root, { maxFiles: 2 });
      assert.equal(capped.length, 2);
    });
  });

  describe("createUnifiedDiff", () => {
    it("formats added, removed, and unchanged lines with unified headers", () => {
      const diff = createUnifiedDiff("src/file.ts", "line1\noldLine\nline3", "line1\nnewLine\nline3");
      assert.equal(
        diff,
        [
          "--- a/src/file.ts",
          "+++ b/src/file.ts",
          "@@ -1,3 +1,3 @@",
          "-oldLine",
          " line1",
          "+newLine",
          " line3",
          "",
        ].join("\n")
      );
    });

    it("handles empty oldStr for newly created files", () => {
      const diff = createUnifiedDiff("new.ts", "", "export const a = 1;");
      assert.equal(
        diff,
        ["--- a/new.ts", "+++ b/new.ts", "@@ -1,0 +1,1 @@", "+export const a = 1;", ""].join("\n")
      );
    });
  });

  describe("getResolvedGitSha", () => {
    it("returns the 40-char HEAD sha in strict mode for a git repo", () => {
      const repo = makeTempDir("repomap-git-");
      execSync("git init -b main", { cwd: repo, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: repo, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: repo, stdio: "ignore" });
      fs.writeFileSync(path.join(repo, "a.txt"), "hello", "utf8");
      execSync("git add -A && git commit -m 'init'", { cwd: repo, stdio: "ignore" });

      const sha = getResolvedGitSha(repo, { strict: true });
      assert.match(sha, /^[0-9a-f]{40}$/i);
    });

    it("throws in strict mode when directory is not a git repo", () => {
      const dir = makeTempDir("repomap-nogit-");
      assert.throws(() => getResolvedGitSha(dir, { strict: true }), /No git repository found/);
    });
  });
});
