import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  buildDetachedRolloutCommand,
  clearDeploySuspension,
  isDeploySuspended,
  readDeployRecord,
  writeDeployRecord,
} from "../lib/deploy/deployRecordStore";
import { GET as deployGet, POST as deployPost } from "../app/api/deploy/route";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";
import { NextRequest } from "next/server";

const requireModule = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(process.cwd(), fs.existsSync("deploy/k8s/web-ui.yaml") ? "." : "..");

describe("Batch 7 — Self-Deploy Architecture (HO-1, SYS-1, DUR-2)", () => {
  it("DUR-2: deploy/k8s/web-ui.yaml declares strategy.type: Recreate", () => {
    const manifest = fs.readFileSync(path.join(REPO_ROOT, "deploy/k8s/web-ui.yaml"), "utf8");
    assert.match(manifest, /strategy:\s*\r?\n\s*type:\s*Recreate/);
  });

  it("HO-1/SYS-1: build-import-image.js executes zero kubectl commands and rollout-deploy.js rolls back & persists suspension on S4 failure", async () => {
    const { buildAndImportService } = requireModule(
      path.join(REPO_ROOT, "scripts/build-import-image.js")
    ) as {
      buildAndImportService: (
        service: string,
        opts: { run: (cmd: string) => string; shortSha: string; fullSha: string; timestamp: string }
      ) => { imageName: string };
    };
    const buildCmds: string[] = [];
    const built = buildAndImportService("web-ui", {
      run: (cmd) => {
        buildCmds.push(cmd);
        return "ok";
      },
      shortSha: "abc1234",
      fullSha: "abc1234567890abcdef1234567890abcdef12345",
      timestamp: "ts1",
    });
    assert.ok(built.imageName.includes("local-agentic-sandbox-web-ui:v-abc1234-ts1"));
    assert.ok(
      buildCmds.every((c) => !/\bkubectl\b/i.test(c)),
      "build-import-image must never call kubectl"
    );

    const { rolloutService } = requireModule(path.join(REPO_ROOT, "scripts/rollout-deploy.js")) as {
      rolloutService: (
        params: Record<string, string>,
        opts?: {
          runCmd?: (cmd: string) => string;
          probeUrl?: (url: string) => Promise<number>;
        }
      ) => Promise<Record<string, unknown>>;
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b7-rollout-"));
    const recordPath = path.join(tmpDir, ".agent", "deploy-record.json");
    try {
      const cmds: string[] = [];
      let probeCalls = 0;
      const record = await rolloutService(
        {
          service: "web-ui",
          image: "local-agentic-sandbox-web-ui:v-bad1234",
          rollbackImage: "local-agentic-sandbox-web-ui:v-good111",
          recordPath,
          gatewayUrl: "http://127.0.0.1:3001",
        },
        {
          runCmd: (cmd) => {
            cmds.push(cmd);
            return "ok";
          },
          probeUrl: async () => {
            probeCalls++;
            // First probe (new image) fails 502; rollback verification succeeds 200
            return probeCalls === 1 ? 502 : 200;
          },
        }
      );

      assert.equal(record.status, "rolled_back_suspended");
      assert.equal(record.suspended, true);
      assert.equal(record.rollbackVerified, true);
      assert.ok(cmds.some((c) => c.includes("v-bad1234")));
      assert.ok(cmds.some((c) => c.includes("v-good111")));

      // Verify persisted record on disk survives restart
      assert.equal(isDeploySuspended(recordPath), true);
      const persisted = readDeployRecord(recordPath);
      assert.equal(persisted?.status, "rolled_back_suspended");
      assert.equal(persisted?.suspended, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("HO-1: persisted deploy suspension is surfaced by GET /api/deploy and cleared only by explicit owner clearSuspension action", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b7-suspend-"));
    const prevWs = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
    try {
      writeDeployRecord({
        status: "rolled_back_suspended",
        targetImage: "local-agentic-sandbox-web-ui:v-bad",
        rollbackTarget: "local-agentic-sandbox-web-ui:v-prev",
        suspended: true,
        suspendedReason: "S4 failed",
        updatedAt: new Date().toISOString(),
      });

      const getRes1 = await deployGet(new NextRequest("http://localhost:3000/api/deploy"));
      const data1 = (await getRes1.json()) as {
        deploySuspended: boolean;
        deployRecord: { status: string };
      };
      assert.equal(data1.deploySuspended, true);
      assert.equal(data1.deployRecord.status, "rolled_back_suspended");

      const clearReq = new NextRequest("http://localhost:3000/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "localhost:3000" },
        body: JSON.stringify({ action: "clearSuspension" }),
      });
      const clearRes = await deployPost(clearReq);
      assert.equal(clearRes.status, 200);
      const clearData = (await clearRes.json()) as { deploySuspended: boolean };
      assert.equal(clearData.deploySuspended, false);
      assert.equal(isDeploySuspended(), false);

      // Verify clearDeploySuspension helper directly and detached command builder
      clearDeploySuspension();
      const cmd = buildDetachedRolloutCommand({
        image: "local-agentic-sandbox-web-ui:v-abc1234",
        rollbackImage: "local-agentic-sandbox-web-ui:v-prev",
      });
      assert.ok(cmd.includes("scripts/rollout-deploy.js --detached"));
    } finally {
      closeSharedRunLedger();
      if (prevWs === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = prevWs;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
