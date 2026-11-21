import fs from "node:fs";
import path from "node:path";

/**
 * Grade compaction-retention against banked Arm A reference numbers.
 * @param {string} output
 * @param {{ minIdentifiersRetained?: number, minRetentionRatio?: number }} passBar
 * @param {string} repoRoot
 * @param {number} [sourceLength]
 */
export async function gradeCompactionRetention(output, passBar, repoRoot, sourceLength) {
  const refPath = path.join(repoRoot, "eval/tasks/compaction-retention/arm-a-reference.json");
  const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
  const text = output || "";

  const identifiers = ref.identifiers || [];
  const retained = identifiers.filter((id) => text.includes(id));

  let baselineLen = sourceLength;
  if (!baselineLen) {
    const promptText = fs.readFileSync(
      path.join(repoRoot, "eval/tasks/compaction-retention/prompt.txt"),
      "utf8"
    );
    const marker = "=== SESSION CONTEXT ===";
    const idx = promptText.indexOf(marker);
    baselineLen =
      idx >= 0 ? promptText.slice(idx + marker.length).trim().length : promptText.length;
  }

  const retentionRatio = baselineLen > 0 ? text.length / baselineLen : 0;
  const minIds = passBar.minIdentifiersRetained ?? identifiers.length;
  const minRatio = passBar.minRetentionRatio ?? 0.45;

  const passed = retained.length >= minIds && retentionRatio >= minRatio;

  return {
    passed,
    evidence: {
      retainedIdentifiers: retained,
      retainedCount: retained.length,
      totalIdentifiers: identifiers.length,
      retentionRatio: Number(retentionRatio.toFixed(3)),
      referenceRatio: ref.referenceRetentionRatio,
    },
  };
}
