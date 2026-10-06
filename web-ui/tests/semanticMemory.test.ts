import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  generateOllamaEmbedding,
  searchSemanticMemory,
  getQdrantCollectionInfo,
  emptyQdrantCollection,
  DEFAULT_QDRANT_COLLECTION
} from "../lib/memory/semanticMemory.js";
import {
  checkOllama,
  checkQdrant,
  enableOllamaMock,
  enableQdrantMock,
  disableOllamaMock,
  disableQdrantMock,
  logServiceMode
} from "./helpers/serviceMocks.js";
import {
  recordObservedPattern,
  approveSkillCandidate,
  rejectSkillCandidate,
  listActiveSkills,
  loadPendingQueue
} from "../lib/subagents/skillGate.js";

describe("Phase D — Tier 2 Semantic Memory & Skill Gate Suite", () => {
  let useRealOllama = false;
  let useRealQdrant = false;

  before(async () => {
    useRealOllama = await checkOllama();
    logServiceMode("ollama", useRealOllama);
    if (!useRealOllama) enableOllamaMock();

    useRealQdrant = await checkQdrant();
    logServiceMode("qdrant", useRealQdrant);
    if (!useRealQdrant) enableQdrantMock();
  });

  after(() => {
    if (!useRealOllama) disableOllamaMock();
    if (!useRealQdrant) disableQdrantMock();
  });
  it("Ollama embeddings: generates dense vectors with real dimension", async () => {
    const vec = await generateOllamaEmbedding("Supervisor worker crash recovery");
    assert.ok(Array.isArray(vec));
    assert.equal(vec.length, 384);
    assert.ok(typeof vec[0] === "number");
  });

  it("Locality: Ollama unreachable throws loudly during embedding generation", async () => {
    await assert.rejects(
      async () => {
        await generateOllamaEmbedding("test prompt", { baseUrl: "http://127.0.0.1:9999" });
      },
      /Ollama embedding service unreachable/i
    );
  });

  it("Locality: searchSemanticMemory flags degradation explicitly when Ollama is down", async () => {
    const res = await searchSemanticMemory("test query", { ollamaUrl: "http://127.0.0.1:9999" });
    assert.equal(res.degraded, true);
    assert.ok(res.degradationReason?.includes("Ollama embedding service unreachable"));
    assert.deepEqual(res.citations, []);
  });

  it("Qdrant collection count: reports vector count and queryable state", async () => {
    const info = await getQdrantCollectionInfo(DEFAULT_QDRANT_COLLECTION);
    assert.equal(info.exists, true);
    assert.ok(info.pointsCount > 0, "Collection must hold >0 vectors after docs ingest");
  });

  it("Semantic recall: queries matching docs return real file:line citations", async () => {
    const res = await searchSemanticMemory("How does the supervisor handle a crashed worker?", {
      collectionName: DEFAULT_QDRANT_COLLECTION
    });
    assert.equal(res.degraded, false);
    assert.ok(res.citations.length > 0, "Must return citations for grounded question");
    assert.ok(res.citations.some((c) => c.includes("ADR-002-langgraph-supervisor-checkpoints.md")));
    assert.ok(res.contextSnippet.includes("--- GROUNDED KNOWLEDGE & VERIFIED CITATIONS ---"));
  });

  it("Semantic recall: empty Qdrant collection returns zero citations without errors", async () => {
    const tempCollection = "test-empty-" + Date.now();
    try {
      await emptyQdrantCollection(tempCollection);
      const res = await searchSemanticMemory("How does the supervisor handle a crashed worker?", {
        collectionName: tempCollection
      });
      assert.equal(res.degraded, false);
      assert.deepEqual(res.citations, []);
      assert.equal(res.contextSnippet, "");
    } finally {
      const qUrl = process.env.QDRANT_URL || "http://127.0.0.1:6333";
      await fetch(`${qUrl}/collections/${tempCollection}`, { method: "DELETE" }).catch(() => {});
    }
  });

  it("Gated skill recorder: 3x repeated pattern -> candidate in pending queue, active skills unchanged", () => {
    const tempSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gated-skills-"));
    try {
      const patternKey = "fix-null-pointer-in-tree-traversal";
      const details = {
        title: "Check node existence before reading children",
        solutionSummary: "Ensure if (!node) return null; is added at top of recursive tree walker."
      };

      // 1st occurrence: recorded, not pending approval, 0 active skills
      const o1 = recordObservedPattern(patternKey, details, { skillsDir: tempSkillsDir });
      assert.equal(o1.candidate.occurrences, 1);
      assert.equal(o1.isPendingApproval, false);
      assert.equal(o1.promoted, false);
      assert.deepEqual(listActiveSkills(tempSkillsDir), []);

      // 2nd occurrence: recorded, not pending approval, 0 active skills
      const o2 = recordObservedPattern(patternKey, details, { skillsDir: tempSkillsDir });
      assert.equal(o2.candidate.occurrences, 2);
      assert.equal(o2.isPendingApproval, false);
      assert.equal(o2.promoted, false);
      assert.deepEqual(listActiveSkills(tempSkillsDir), []);

      // 3rd occurrence: hits 3x threshold -> now isPendingApproval: true, BUT still NOT promoted!
      const o3 = recordObservedPattern(patternKey, details, { skillsDir: tempSkillsDir });
      assert.equal(o3.candidate.occurrences, 3);
      assert.equal(o3.isPendingApproval, true);
      assert.equal(o3.promoted, false, "NOTHING auto-promotes without explicit user approval");
      assert.deepEqual(listActiveSkills(tempSkillsDir), [], "Active skills MUST remain empty before approval");

      // Verify pending queue state on disk
      const queue = loadPendingQueue(tempSkillsDir);
      assert.ok(queue.candidates[patternKey]);
      assert.equal(queue.candidates[patternKey].status, "pending");

      // User Approval Gate: approve -> now promotes to active skill .md
      const approved = approveSkillCandidate(patternKey, { skillsDir: tempSkillsDir });
      assert.equal(approved.promoted, true);
      assert.ok(approved.skillPath && fs.existsSync(approved.skillPath));

      // Active skills now holds the 1 promoted skill
      const active = listActiveSkills(tempSkillsDir);
      assert.equal(active.length, 1);
      assert.ok(active[0].includes("check-node-existence"));

      // Verify approved content
      const content = fs.readFileSync(approved.skillPath!, "utf8");
      assert.ok(content.includes("Check node existence before reading children"));
      assert.ok(content.includes("occurrences: 3"));
    } finally {
      fs.rmSync(tempSkillsDir, { recursive: true, force: true });
    }
  });

  it("Gated skill recorder: user rejection marks candidate rejected without creating skill file", () => {
    const tempSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gated-skills-rej-"));
    try {
      const patternKey = "bad-pattern-to-reject";
      recordObservedPattern(patternKey, { title: "Bad pattern", solutionSummary: "Don't promote" }, { skillsDir: tempSkillsDir });
      recordObservedPattern(patternKey, { title: "Bad pattern", solutionSummary: "Don't promote" }, { skillsDir: tempSkillsDir });
      recordObservedPattern(patternKey, { title: "Bad pattern", solutionSummary: "Don't promote" }, { skillsDir: tempSkillsDir });

      const rej = rejectSkillCandidate(patternKey, { skillsDir: tempSkillsDir });
      assert.equal(rej.rejected, true);
      assert.deepEqual(listActiveSkills(tempSkillsDir), []);

      const queue = loadPendingQueue(tempSkillsDir);
      assert.equal(queue.candidates[patternKey].status, "rejected");
    } finally {
      fs.rmSync(tempSkillsDir, { recursive: true, force: true });
    }
  });
});
