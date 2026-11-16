import fs from "node:fs";
import path from "node:path";

/**
 * Grade forensic-diagnosis output against banked key and pass bar.
 * @param {string} output
 * @param {{ requiredRootCauseKeywords?: string[], minKeywordMatches?: number, mustNotClaimFixed?: boolean }} passBar
 * @param {string} repoRoot
 */
export async function gradeForensicDiagnosis(output, passBar, repoRoot) {
  const keyPath = path.join(repoRoot, "eval/tasks/forensic-diagnosis/key.json");
  const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const text = (output || "").toLowerCase();

  const keywords = passBar.requiredRootCauseKeywords || key.requiredKeywords || [];
  const matched = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  const minMatches = passBar.minKeywordMatches ?? keywords.length;

  const forbidden = key.forbiddenClaims || [];
  const claimedFixed = passBar.mustNotClaimFixed && forbidden.some((p) => text.includes(p.toLowerCase()));

  const passed = matched.length >= minMatches && !claimedFixed;
  return {
    passed,
    evidence: {
      matchedKeywords: matched,
      requiredCount: minMatches,
      claimedFixed,
    },
  };
}
