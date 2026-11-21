import test from "node:test";
import assert from "node:assert/strict";
import {
  SELF_DEPLOY_VERIFIED_STAGE_DEFAULT,
  isSelfDeployVerifiedEnabled,
  runSelfDeployVerified,
  generateSprintReport,
  type SelfDeployVerifiedDeps,
  type DeployInput,
} from "../lib/deploy/selfDeployVerified";
import type { BoardItem } from "../lib/board/boardStore";

function makeBaseDeps(overrides: Partial<SelfDeployVerifiedDeps> = {}): SelfDeployVerifiedDeps {
  const calls: string[] = [];
  return {
    readCurrentState: async () => {
      calls.push("S0:readCurrentState");
      return {
        image: "local-agentic-sandbox:v1.0.0-prev",
        podStatus: "Running",
        podRestarts: 0,
      };
    },
    bankRollbackTarget: async (tag: string) => {
      calls.push(`S1:bankRollbackTarget:${tag}`);
      return { banked: true, tag };
    },
    buildAndImport: async (targetTag: string, dryRun: boolean) => {
      calls.push(`S2:buildAndImport:${targetTag}:dryRun=${dryRun}`);
      return {
        built: true,
        imported: true,
        imagePresentInNode: true,
        detail: `image ${targetTag} present in node`,
      };
    },
    setImage: async (tag: string) => {
      calls.push(`S3:setImage:${tag}`);
      return { ok: true };
    },
    verifyDeployment: async (expectedTag: string) => {
      calls.push(`S4:verifyDeployment:${expectedTag}`);
      return {
        ok: true,
        rolloutSuccess: true,
        podRunningZeroRestarts: true,
        gatewayStatus: 200,
        threadListLoads: true,
        observedTag: expectedTag,
      };
    },
    ...overrides,
  };
}

const BASE_INPUT: DeployInput = {
  targetTag: "local-agentic-sandbox:v1.1.0-dev",
  developSha: "abc1234",
};

test("stage flag defaults to OFF (shadow mode)", () => {
  assert.equal(SELF_DEPLOY_VERIFIED_STAGE_DEFAULT, false);
  assert.equal(isSelfDeployVerifiedEnabled(), false);
  assert.equal(isSelfDeployVerifiedEnabled(true), true);
  assert.equal(isSelfDeployVerifiedEnabled(false), false);
});

test("shadow mode (default OFF) prepares and verifies readiness but NEVER executes setImage", async () => {
  const calls: string[] = [];
  const deps = makeBaseDeps({
    readCurrentState: async () => {
      calls.push("S0");
      return { image: "local-agentic-sandbox:v1.0.0-prev", podStatus: "Running", podRestarts: 0 };
    },
    bankRollbackTarget: async (tag) => {
      calls.push(`S1:${tag}`);
      return { banked: true, tag };
    },
    buildAndImport: async (tag, dryRun) => {
      calls.push(`S2:${tag}:dryRun=${dryRun}`);
      return { built: true, imported: true, imagePresentInNode: true, detail: "dry-run ok" };
    },
    setImage: async (tag) => {
      calls.push(`S3:${tag}`);
      return { ok: true };
    },
  });

  const result = await runSelfDeployVerified(BASE_INPUT, deps);

  assert.equal(result.mode, "shadow");
  assert.equal(result.status, "shadow_prepared");
  assert.equal(result.rollbackTarget, "local-agentic-sandbox:v1.0.0-prev");
  assert.equal(
    calls.some((c) => c.startsWith("S3:")),
    false,
    "setImage must NEVER be called in shadow mode"
  );
  assert.ok(calls.includes("S2:local-agentic-sandbox:v1.1.0-dev:dryRun=true"));
});

test("deploy with no banked rollback target refuses to proceed", async () => {
  const calls: string[] = [];
  const deps = makeBaseDeps({
    readCurrentState: async () => {
      calls.push("S0");
      return { image: "", podStatus: "Running", podRestarts: 0 };
    },
    bankRollbackTarget: async (tag) => {
      calls.push(`S1:${tag}`);
      return { banked: false, tag: "" };
    },
    buildAndImport: async () => {
      calls.push("S2");
      return { built: true, imported: true, imagePresentInNode: true, detail: "ok" };
    },
    setImage: async () => {
      calls.push("S3");
      return { ok: true };
    },
  });

  const result = await runSelfDeployVerified(BASE_INPUT, deps, { stageEnabled: true });

  assert.equal(result.status, "refused");
  assert.match(result.reason ?? "", /rollback target/i);
  assert.equal(calls.includes("S2"), false, "build must not start without banked rollback target");
  assert.equal(calls.includes("S3"), false, "setImage must not run without banked rollback target");
});

test("S4 failure rolls back to banked tag, verifies rollback, and surfaces needs-attention with evidence", async () => {
  const setImageTags: string[] = [];
  const deps = makeBaseDeps({
    setImage: async (tag) => {
      setImageTags.push(tag);
      return { ok: true };
    },
    verifyDeployment: async (expectedTag) => {
      if (expectedTag === BASE_INPUT.targetTag) {
        return {
          ok: false,
          rolloutSuccess: true,
          podRunningZeroRestarts: false,
          gatewayStatus: 502,
          threadListLoads: false,
          observedTag: expectedTag,
          failedStep: "gateway_200",
          observed: "gateway returned 502; pod restarts=2",
        };
      }
      return {
        ok: true,
        rolloutSuccess: true,
        podRunningZeroRestarts: true,
        gatewayStatus: 200,
        threadListLoads: true,
        observedTag: expectedTag,
      };
    },
  });

  const result = await runSelfDeployVerified(BASE_INPUT, deps, { stageEnabled: true });

  assert.deepEqual(setImageTags, [BASE_INPUT.targetTag, "local-agentic-sandbox:v1.0.0-prev"]);
  assert.equal(result.status, "rolled_back_suspended");
  assert.equal(result.needsAttention, true);
  assert.equal(result.rollbackTarget, "local-agentic-sandbox:v1.0.0-prev");
  assert.equal(result.rollbackVerified, true);
  assert.match(result.evidence ?? "", /gateway_200/);
  assert.match(result.evidence ?? "", /502/);
});

test("successful S4 marks prod == develop with deploy tag recorded", async () => {
  const deps = makeBaseDeps();
  const result = await runSelfDeployVerified(BASE_INPUT, deps, { stageEnabled: true });

  assert.equal(result.mode, "execute");
  assert.equal(result.status, "deployed");
  assert.equal(result.prodEqualsDevelop, true);
  assert.equal(result.deployTag, BASE_INPUT.targetTag);
  assert.equal(result.needsAttention, false);
});

test("sprint report names PR, merge SHA, deploy tag, status, and evidence per item and surfaces exceptions", () => {
  const items: BoardItem[] = [
    {
      id: "item-24",
      key: "reviewer-gate",
      title: "Reviewer gate",
      brief: "Mechanical reviewer gate",
      dependencies: [],
      status: "done",
      author: "Owner",
      source: "assistant",
      evidence: { prNumber: 125, mergeSha: "3e0a866", deployTag: "v1.0.0" },
      createdAt: "2026-11-15T00:00:00Z",
      updatedAt: "2026-11-16T00:00:00Z",
    },
    {
      id: "item-25",
      key: "self-deploy-verified",
      title: "Self-deploy verified",
      brief: "Deploy protocol v3",
      dependencies: ["item-24"],
      status: "parked",
      parkedReason: "needs-attention: S4 gateway_200 failed (502)",
      author: "Owner",
      source: "assistant",
      evidence: { prNumber: 126, mergeSha: "def5678", deployTag: "v1.1.0-dev" },
      createdAt: "2026-11-16T00:00:00Z",
      updatedAt: "2026-11-16T01:00:00Z",
    },
  ];

  const report = generateSprintReport(items);

  assert.equal(report.items.length, 2);
  assert.deepEqual(report.items[0], {
    key: "reviewer-gate",
    prNumber: 125,
    mergeSha: "3e0a866",
    deployTag: "v1.0.0",
    status: "done",
    evidence: "PR #125 | merge 3e0a866 | tag v1.0.0",
  });
  assert.equal(report.exceptions.length, 1);
  assert.equal(report.exceptions[0].key, "self-deploy-verified");
  assert.match(report.exceptions[0].reason, /needs-attention/);
  assert.match(report.markdown, /#125/);
  assert.match(report.markdown, /3e0a866/);
  assert.match(report.markdown, /v1\.0\.0/);
  assert.match(report.markdown, /needs-attention/);
});

test("primary S3 setImage failure aborts before S4 without rollback", async () => {
  const calls: string[] = [];
  const deps = makeBaseDeps({
    setImage: async (tag) => {
      calls.push(`S3:${tag}`);
      return { ok: false, detail: "kubectl set image exited 1" };
    },
    verifyDeployment: async (tag) => {
      calls.push(`S4:${tag}`);
      return {
        ok: true,
        rolloutSuccess: true,
        podRunningZeroRestarts: true,
        gatewayStatus: 200,
        threadListLoads: true,
        observedTag: tag,
      };
    },
  });

  const result = await runSelfDeployVerified(BASE_INPUT, deps, { stageEnabled: true });

  assert.equal(result.status, "failed");
  assert.equal(result.needsAttention, true);
  assert.match(result.evidence ?? "", /kubectl set image exited 1/);
  assert.equal(calls.filter((c) => c.startsWith("S3:")).length, 1, "no rollback setImage");
  assert.equal(calls.some((c) => c.startsWith("S4:")), false, "S4 must not run after S3 failure");
});

test("rollback S3 setImage failure surfaces rollbackVerified=false and failure in evidence", async () => {
  let setCount = 0;
  const deps = makeBaseDeps({
    setImage: async () => {
      setCount++;
      if (setCount === 1) return { ok: true };
      return { ok: false, detail: "rollback kubectl error" };
    },
    verifyDeployment: async (expectedTag) => ({
      ok: false,
      rolloutSuccess: true,
      podRunningZeroRestarts: false,
      gatewayStatus: 502,
      threadListLoads: false,
      observedTag: expectedTag,
      failedStep: "gateway_200",
      observed: "gateway returned 502",
    }),
  });

  const result = await runSelfDeployVerified(BASE_INPUT, deps, { stageEnabled: true });

  assert.equal(result.status, "rolled_back_suspended");
  assert.equal(result.rollbackVerified, false);
  assert.equal(result.needsAttention, true);
  assert.match(result.evidence ?? "", /rollback kubectl error/);
});

test("S3 setImage and S4 verifyDeployment use buildAndImport builtTag instead of input targetTag", async () => {
  let setTag = "";
  let verifiedTag = "";
  const deps = makeBaseDeps({
    buildAndImport: async () => ({
      built: true,
      imported: true,
      imagePresentInNode: true,
      builtTag: "local-agentic-sandbox-web-ui:v-abc1234-xyz",
      detail: "built v-abc1234-xyz",
    }),
    setImage: async (tag) => {
      setTag = tag;
      return { ok: true };
    },
    verifyDeployment: async (tag) => {
      verifiedTag = tag;
      return {
        ok: true,
        rolloutSuccess: true,
        podRunningZeroRestarts: true,
        gatewayStatus: 200,
        threadListLoads: true,
        observedTag: tag,
      };
    },
  });

  const result = await runSelfDeployVerified(BASE_INPUT, deps, { stageEnabled: true });

  assert.equal(result.status, "deployed");
  assert.equal(setTag, "local-agentic-sandbox-web-ui:v-abc1234-xyz");
  assert.equal(verifiedTag, "local-agentic-sandbox-web-ui:v-abc1234-xyz");
  assert.equal(result.deployTag, "local-agentic-sandbox-web-ui:v-abc1234-xyz");
});
