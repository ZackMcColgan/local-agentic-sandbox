import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Flash 3.8 Backend Shakeout — Fix 1: B-P0-1 Dockerfile & BuilderWorker Surgical Patch", () => {
  it("web-ui/Dockerfile copies workspace package.json files in Stage 1", () => {
    const dockerfileContent = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/Dockerfile"),
      "utf8"
    );
    assert.match(
      dockerfileContent,
      /COPY mcp-server\/package\*\.json \.\/mcp-server\//,
      "Dockerfile Stage 1 must copy mcp-server/package*.json"
    );
    assert.match(
      dockerfileContent,
      /COPY browser-mcp\/package\*\.json \.\/browser-mcp\//,
      "Dockerfile Stage 1 must copy browser-mcp/package*.json"
    );
  });

  it("web-ui/lib/subagents/workerPool.ts has zero cross-package relative imports from ../../../mcp-server", () => {
    const workerPoolCode = fs.readFileSync(
      path.resolve(process.cwd(), "web-ui/lib/subagents/workerPool.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      workerPoolCode,
      /\.\.\/\.\.\/\.\.\/mcp-server/,
      "workerPool.ts must not use cross-package relative imports to mcp-server (Anti-Shit Protocol Rule 5)"
    );
  });

  it("BuilderWorker executes surgical patchFile when model returns patch payload for existing file", async () => {
    const { BuilderWorker } = await import("../lib/subagents/workerPool.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "builder-patch-test-"));

    try {
      const targetRel = "src/math.ts";
      const fullTarget = path.join(tmpDir, targetRel);
      fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
      fs.writeFileSync(
        fullTarget,
        "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
        "utf8"
      );

      let patchFileCalled = false;
      const mockGenerate = async () => ({
        text: JSON.stringify({
          patches: [
            {
              search: "return a - b;",
              replace: "return a + b;"
            }
          ]
        })
      });

      const builder = new BuilderWorker({
        workspaceRoot: tmpDir,
        generate: mockGenerate as any
      });

      // Spy on patchFile method
      const originalPatch = builder.patchFile.bind(builder);
      builder.patchFile = async (rel, patches, root) => {
        patchFileCalled = true;
        return originalPatch(rel, patches, root);
      };

      const milestone = {
        id: "M1",
        title: "Fix addition operator in math.ts",
        description: "Replace subtraction with addition",
        status: "pending" as const,
        builderIterations: 0,
        criticRounds: 0,
        plannedFiles: [targetRel],
        acceptanceCriteria: [
          {
            id: "AC-1",
            assertion: "add returns a + b",
            fileMatch: targetRel
          }
        ]
      };

      const result = await builder.executeMilestoneWork(milestone, 1, [], tmpDir);

      assert.equal(patchFileCalled, true, "BuilderWorker.patchFile must be invoked when model returns patch payload");
      const patchedContent = fs.readFileSync(fullTarget, "utf8");
      assert.match(patchedContent, /return a \+ b;/, "File must contain patched content");
      assert.doesNotMatch(patchedContent, /return a - b;/, "Original flaw must be replaced");
      assert.ok(result.diff.includes("+  return a + b;"), "Unified diff must reflect the applied patch");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
