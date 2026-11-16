import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runModelEvalPack } from "../lib/eval/modelEvalPack";
import { confinePathToRoot, isSafePublicUrl, verifyLanBridgeAuth } from "../lib/securityHardening";
import { prepareSelfDeployPlan } from "../lib/selfDeployMachinery";
import { toQdrantPointId, cosineSimilarity, InMemorySemanticStore } from "../lib/oracle/ingestionRoundTrip";

describe("P6.1–P6.4: Eval pack, security hardening, shadow self-deploy, Qdrant ingestion", () => {
  it("P6.1: runModelEvalPack evaluates cases against banked pass bars", async () => {
    const result = await runModelEvalPack({
      passBar: 0.5,
      cases: [
        { id: "c1", prompt: "2+2?", expectedSubstring: "4" },
        { id: "c2", prompt: "capital of france?", expectedSubstring: "Paris" },
      ],
      infer: async (prompt) => (prompt.includes("2+2") ? "4" : "Paris"),
    });
    assert.equal(result.passed, true);
    assert.equal(result.score, 1);
  });

  it("P6.2: root confinement, SSRF guard, and lan-bridge auth", () => {
    assert.throws(() => confinePathToRoot("/workspace", "../../etc/passwd"), /traversal|outside/i);
    assert.ok(confinePathToRoot("/workspace", "src/index.ts").endsWith("index.ts"));

    assert.equal(isSafePublicUrl("http://127.0.0.1:8080/admin"), false);
    assert.equal(isSafePublicUrl("http://169.254.169.254/latest/meta-data"), false);
    assert.equal(isSafePublicUrl("https://example.com/docs"), true);

    assert.equal(verifyLanBridgeAuth("secret-123", "Bearer wrong"), false);
    assert.equal(verifyLanBridgeAuth("secret-123", "Bearer secret-123"), true);
  });

  it("P6.3: self-deploy machinery banks rollback target first and stays in shadow mode", () => {
    const plan = prepareSelfDeployPlan({
      currentImage: "local-sandbox:v1",
      targetImage: "local-sandbox:v2",
      healthUrl: "http://127.0.0.1:3001/api/health",
      shadowMode: true,
    });
    assert.equal(plan.shadowOnly, true);
    assert.equal(plan.rollbackTarget, "local-sandbox:v1");
    assert.equal(plan.steps[0], "bank_rollback_target:local-sandbox:v1");
    assert.ok(plan.steps.includes("auto_rollback_on_verify_fail"));
  });

  it("P6.4 (B-14): valid Qdrant point IDs and semantic vector ingestion round-trip", () => {
    const id = toQdrantPointId("doc/readme.md#chunk-1");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const store = new InMemorySemanticStore();
    store.ingest("doc-1", "kubernetes pod restart policy", [0.9, 0.1, 0.0]);
    store.ingest("doc-2", "chocolate cake recipe", [0.0, 0.1, 0.9]);

    const hits = store.retrieve([0.88, 0.12, 0.0], 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, "kubernetes pod restart policy");
    assert.ok(cosineSimilarity([0.9, 0.1, 0.0], [0.88, 0.12, 0.0]) > 0.99);
  });
});
