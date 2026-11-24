import fs from "fs/promises";
import fsSync from "fs";
import { resolveRealConfinedPath } from "./pathConfinement.js";

export interface PatchItem {
  search: string;
  replace: string;
}

export interface PatchFileResult {
  status: "SUCCESS" | "EXECUTION_ERROR";
  path: string;
  patchesApplied: number;
  bytesWritten: number;
  error?: string;
}

export function resolveSafeWorkspacePath(workspaceRoot: string, userPath: string): string {
  return resolveRealConfinedPath(workspaceRoot, userPath);
}

/**
 * Surgical Search/Replace Patch Tool
 * Applies patches in sequence against target file within workspaceRoot.
 * Fails loudly if search target is not found.
 */
export async function workspacePatchFile(
  workspaceRoot: string,
  relativePath: string,
  patches: Array<PatchItem>
): Promise<PatchFileResult> {
  if (!patches || !Array.isArray(patches) || patches.length === 0) {
    throw new Error("Patches array must contain at least one { search, replace } patch");
  }

  const safePath = resolveSafeWorkspacePath(workspaceRoot, relativePath);
  if (!fsSync.existsSync(safePath)) {
    throw new Error(`File not found to patch: ${relativePath}`);
  }

  let content = await fs.readFile(safePath, "utf8");
  let appliedCount = 0;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    if (typeof patch.search !== "string" || typeof patch.replace !== "string") {
      throw new Error(`Patch at index ${i} must provide 'search' and 'replace' strings`);
    }

    if (!content.includes(patch.search)) {
      throw new Error(
        `Target text not found in ${relativePath}: ${JSON.stringify(patch.search.slice(0, 100))}`
      );
    }

    content = content.replace(patch.search, patch.replace);
    appliedCount++;
  }

  await fs.writeFile(safePath, content, "utf8");

  return {
    status: "SUCCESS",
    path: relativePath,
    patchesApplied: appliedCount,
    bytesWritten: Buffer.byteLength(content, "utf8"),
  };
}
