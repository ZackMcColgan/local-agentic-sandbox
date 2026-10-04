/**
 * Phase D Behavioral Acceptance Experiments 7–12
 * Antigravity Order: Full Gambit Overnight — Phase D Tier 2 Qdrant semantic memory + skill gate + eval
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import assert from "node:assert/strict";

import {
  generateOllamaEmbedding,
  ingestDocsToQdrant,
  searchSemanticMemory,
  getQdrantCollectionInfo,
  emptyQdrantCollection,
  DEFAULT_QDRANT_COLLECTION
} from "../web-ui/lib/memory/semanticMemory.ts";
import {
  recordObservedPattern,
  approveSkillCandidate,
  rejectSkillCandidate,
  listActiveSkills,
  loadPendingQueue
} from "../web-ui/lib/subagents/skillGate.ts";

console.log("[Phase D] Running Behavioral Acceptance Experiments 7–12...\n");

async function runExperiments() {
  // Experiment 7: Ingest over repo docs -> collection holds >0 vectors, count reported and queryable
  console.log("--- Experiment 7: Ingest over repo docs ---");
  const docsDir = path.resolve("docs");
  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
  const docs = files.map((f) => ({
    filePath: `docs/${f}`,
    corpus: "docs",
    content: fs.readFileSync(path.join(docsDir, f), "utf8")
  }));

  const ingestRes = await ingestDocsToQdrant(docs);
  assert.ok(ingestRes.pointsCount > 0, `Expected >0 points in Qdrant, got ${ingestRes.pointsCount}`);
  const colInfo = await getQdrantCollectionInfo(DEFAULT_QDRANT_COLLECTION);
  assert.equal(colInfo.exists, true);
  assert.equal(colInfo.pointsCount, ingestRes.pointsCount);
  console.log(`✅ Experiment 7 PASSED: Collection holds ${colInfo.pointsCount} vectors across ${ingestRes.indexedFiles} doc files.\n`);

  // Experiment 8: Recall does the work (question answerable from docs cites file:line; empty Qdrant -> NO citations)
  console.log("--- Experiment 8: Recall does the work ---");
  const q = "How does the supervisor handle a crashed worker or supervisor restart?";
  const populatedRes = await searchSemanticMemory(q);
  assert.equal(populatedRes.degraded, false);
  assert.ok(populatedRes.citations.length > 0, "Must return citations when populated");
  assert.ok(populatedRes.citations.some((c) => c.includes("ADR-002-langgraph-supervisor-checkpoints.md")));
  console.log(`   Populated recall returned citations: ${populatedRes.citations.join(", ")}`);

  // Same question with Qdrant collection emptied
  const emptyCol = "test-empty-exp8-" + Date.now();
  await emptyQdrantCollection(emptyCol);
  const emptyRes = await searchSemanticMemory(q, { collectionName: emptyCol });
  assert.equal(emptyRes.degraded, false);
  assert.equal(emptyRes.citations.length, 0, "Empty Qdrant MUST return NO citations");
  assert.equal(emptyRes.contextSnippet, "");
  console.log("   Empty recall returned 0 citations.");
  // Cleanup empty test collection
  await fetch(`http://127.0.0.1:6333/collections/${emptyCol}`, { method: "DELETE" }).catch(() => {});
  console.log("✅ Experiment 8 PASSED: Docs recall cites file:line; empty Qdrant yields zero citations.\n");

  // Experiment 9: Eval is real (golden-set prints score; empty-Qdrant control scores ~0)
  console.log("--- Experiment 9: Golden-set eval & control ---");
  const tsxCli = path.resolve("web-ui/node_modules/tsx/dist/cli.mjs");
  const evalActiveOut = execSync(`node "${tsxCli}" scripts/eval-memory.js`, { encoding: "utf8" });
  assert.ok(evalActiveOut.includes("Score: 5/5 (100.0%)"), `Expected active score 100%, got output: ${evalActiveOut}`);
  console.log("   Active golden-set eval: 5/5 (100.0%)");

  const evalEmptyOut = execSync(`node "${tsxCli}" scripts/eval-memory.js --control-empty`, { encoding: "utf8" });
  assert.ok(evalEmptyOut.includes("Score: 0/5 (0.0%)"), `Expected empty control score 0%, got output: ${evalEmptyOut}`);
  console.log("   Empty-Qdrant control eval: 0/5 (0.0%)");
  console.log("✅ Experiment 9 PASSED: Golden-set scores 100%; control scores 0%.\n");

  // Experiment 10: The gate holds (3x repeated correction pattern -> candidate in pending queue, active skills unchanged. Approve -> promotes.)
  console.log("--- Experiment 10: Gated skill promotion ---");
  const tempSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-exp10-"));
  try {
    const patternId = "fix-connection-retry-timeout";
    const details = {
      title: "Add exponential backoff with jitter on reconnect",
      solutionSummary: "Wrap connection attempts in retry loop with math.min(1000 * 2^attempt + jitter, 10000)"
    };

    // 1st and 2nd iteration: not pending
    recordObservedPattern(patternId, details, { skillsDir: tempSkillsDir });
    recordObservedPattern(patternId, details, { skillsDir: tempSkillsDir });
    assert.deepEqual(listActiveSkills(tempSkillsDir), [], "Must not create skill file yet");

    // 3rd iteration: hits 3x threshold -> entered pending queue, but STILL NOT in active skills!
    const o3 = recordObservedPattern(patternId, details, { skillsDir: tempSkillsDir });
    assert.equal(o3.candidate.occurrences, 3);
    assert.equal(o3.isPendingApproval, true);
    assert.equal(o3.promoted, false);
    assert.deepEqual(listActiveSkills(tempSkillsDir), [], "Active skills MUST remain empty (no auto-promotion)");
    console.log("   Observed 3x pattern -> pending candidate queued, 0 active skills promoted (gate held).");

    // Explicit approval -> promotes to active skill
    const approval = approveSkillCandidate(patternId, { skillsDir: tempSkillsDir });
    assert.equal(approval.promoted, true);
    assert.ok(approval.skillPath && fs.existsSync(approval.skillPath));
    assert.equal(listActiveSkills(tempSkillsDir).length, 1);
    console.log(`   User approved -> promoted to active skill: ${path.basename(approval.skillPath)}`);
    console.log("✅ Experiment 10 PASSED: Gated promotion verified in both directions.\n");
  } finally {
    fs.rmSync(tempSkillsDir, { recursive: true, force: true });
  }

  // Experiment 11: Ollama down (ingest fails loudly; recall flags degradation explicitly)
  console.log("--- Experiment 11: Ollama down failure & degradation ---");
  let ingestFailedLoudly = false;
  try {
    await ingestDocsToQdrant(docs.slice(0, 1), { ollamaUrl: "http://127.0.0.1:9999" });
  } catch (err) {
    ingestFailedLoudly = true;
    console.log(`   Ingest threw loud error on unreachable Ollama: "${err.message}"`);
  }
  assert.equal(ingestFailedLoudly, true, "Ingest MUST fail loudly when Ollama is down");

  const degradedRecall = await searchSemanticMemory("test query", { ollamaUrl: "http://127.0.0.1:9999" });
  assert.equal(degradedRecall.degraded, true, "Recall must explicitly flag degradation");
  assert.ok(degradedRecall.degradationReason?.includes("Ollama embedding service unreachable"));
  assert.deepEqual(degradedRecall.citations, []);
  console.log(`   Recall flagged degradation explicitly: "${degradedRecall.degradationReason}"`);
  console.log("✅ Experiment 11 PASSED: Ingest fails loudly and recall degrades explicitly on Ollama failure.\n");

  // Experiment 12: No Tier 1 regression (all six Phase C experiments still pass)
  console.log("--- Experiment 12: No Tier 1 regression ---");
  const phaseCOut = execSync(`node scripts/verify-phase-c.js`, { encoding: "utf8" });
  assert.ok(phaseCOut.includes("ALL PHASE C BEHAVIORAL ACCEPTANCE EXPERIMENTS PASSED"));
  console.log("   Re-ran scripts/verify-phase-c.js: All 6 Phase C experiments passed without regression.");
  console.log("✅ Experiment 12 PASSED: Zero Tier 1 regressions.\n");

  console.log("=======================================================");
  console.log("✅ ALL PHASE D BEHAVIORAL ACCEPTANCE EXPERIMENTS PASSED (7–12)");
  console.log("=======================================================\n");
}

runExperiments().catch((err) => {
  console.error("\n❌ [Phase D Failure]:", err);
  process.exit(1);
});
