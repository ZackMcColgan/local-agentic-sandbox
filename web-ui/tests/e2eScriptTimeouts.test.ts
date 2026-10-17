import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("E2E Verification Scripts Timeout & Deadline Enforcer Suite", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const scriptsDir = path.join(repoRoot, "scripts");
  const argonDir = path.join(repoRoot, "argon-cto", "task3");

  const requiredScriptFiles = [
    "scripts/capture-svg-render.js",
    "scripts/test-ui-render.js",
    "scripts/verify-fix3-behavioral.js",
    "scripts/verify-lan-copy.js",
    "scripts/verify-phase-d.js"
  ];

  it("required verification scripts exist in scripts/", () => {
    for (const relPath of requiredScriptFiles) {
      const fullPath = path.join(repoRoot, relPath);
      assert.ok(fs.existsSync(fullPath), `Expected script to exist: ${relPath}`);
    }
  });

  it("every script containing fetch() includes AbortSignal.timeout and a 180s deadline exceeded guard", () => {
    const filesToCheck: string[] = [];

    // Collect all .js and .ts files in scripts/
    if (fs.existsSync(scriptsDir)) {
      const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".ts"))) {
          filesToCheck.push(path.join(scriptsDir, entry.name));
        }
      }
    }

    // Collect all .js files in argon-cto/task3 if exists
    if (fs.existsSync(argonDir)) {
      const entries = fs.readdirSync(argonDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".js")) {
          filesToCheck.push(path.join(argonDir, entry.name));
        }
      }
    }

    const checkedWithFetch: string[] = [];

    for (const filePath of filesToCheck) {
      const relPath = path.relative(repoRoot, filePath);
      const content = fs.readFileSync(filePath, "utf8");

      if (content.includes("fetch(")) {
        checkedWithFetch.push(relPath);

        assert.ok(
          content.includes("AbortSignal.timeout"),
          `File ${relPath} calls fetch() but is missing AbortSignal.timeout`
        );

        assert.ok(
          content.includes("deadline exceeded"),
          `File ${relPath} calls fetch() but is missing a 180s deadline exceeded guard`
        );
      }
    }

    // Verify all 5 core scripts were actually evaluated
    for (const reqFile of requiredScriptFiles) {
      assert.ok(
        checkedWithFetch.includes(reqFile.replace(/\//g, path.sep)) || checkedWithFetch.includes(reqFile),
        `Core script ${reqFile} must be among files with fetch() checks`
      );
    }
  });
});
