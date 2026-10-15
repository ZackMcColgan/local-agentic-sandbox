import fs from "fs";
import path from "path";
import { searchSemanticMemory, getQdrantCollectionInfo, DEFAULT_QDRANT_COLLECTION } from "../web-ui/lib/memory/semanticMemory.ts";

async function runMemoryEval() {
  const isControlEmpty = process.argv.includes("--control-empty");
  const collectionName = isControlEmpty ? "test-control-empty" : (process.env.QDRANT_COLLECTION || DEFAULT_QDRANT_COLLECTION);
  const goldenSetPath = path.resolve("eval/memory-golden-set.json");

  if (!fs.existsSync(goldenSetPath)) {
    console.error(`[Memory Eval] Golden set file not found: ${goldenSetPath}`);
    process.exit(1);
  }

  const goldenSet = JSON.parse(fs.readFileSync(goldenSetPath, "utf8"));
  console.log(`\n=======================================================`);
  console.log(`[Memory Eval] Evaluating Semantic Memory on Golden Set`);
  console.log(`Mode: ${isControlEmpty ? "CONTROL (Empty Qdrant)" : "ACTIVE (Populated Qdrant)"}`);
  console.log(`Collection: ${collectionName}`);
  console.log(`Total Questions: ${goldenSet.questions.length}`);
  console.log(`=======================================================\n`);

  let totalScore = 0;
  const results = [];

  for (const item of goldenSet.questions) {
    const res = await searchSemanticMemory(item.question, { collectionName });
    const hasCitations = res.citations.length > 0;
    const matchedExpectedFile = res.citations.some((c) => c.toLowerCase().includes(item.expectedFile.toLowerCase()));

    let points = 0;
    if (!isControlEmpty && matchedExpectedFile) {
      points = 1;
    }
    totalScore += points;

    results.push({
      id: item.id,
      question: item.question,
      expected: item.expectedFile,
      citations: res.citations,
      passed: points === 1
    });

    console.log(`[Q: ${item.id}] ${points === 1 ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`   Query: "${item.question}"`);
    console.log(`   Expected: ${item.expectedFile}`);
    console.log(`   Returned: ${res.citations.join(", ") || "(none)"}`);
  }

  const scorePct = ((totalScore / goldenSet.questions.length) * 100).toFixed(1);
  console.log(`\n-------------------------------------------------------`);
  console.log(`[Memory Eval Result] Score: ${totalScore}/${goldenSet.questions.length} (${scorePct}%)`);
  console.log(`-------------------------------------------------------\n`);

  if (isControlEmpty && totalScore !== 0) {
    console.error(`[Memory Eval] Expected empty control to score ~0, got ${totalScore}`);
    process.exit(1);
  }

  return { totalScore, maxScore: goldenSet.questions.length, scorePct };
}

runMemoryEval().catch((err) => {
  console.error("[Memory Eval Error]:", err.message);
  process.exit(1);
});
