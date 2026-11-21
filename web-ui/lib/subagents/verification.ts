import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { VerificationAdapters } from "../finishVerification";

export function buildVerificationAdapters(repoRoot: string): VerificationAdapters {
  return {
    resolveCommit: async (sha: string) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", `${sha}^{commit}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    branchExists: async (branch: string) => {
      try {
        execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    fileExists: async (filePath: string) => {
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
      return fs.existsSync(resolved);
    },
    checkPr: async (prNumber: number) => {
      try {
        const out = execFileSync(
          "gh",
          ["pr", "view", String(prNumber), "--json", "state", "--jq", ".state"],
          { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        return { exists: true, state: out || null };
      } catch {
        return { exists: false, state: null };
      }
    },
  };
}
