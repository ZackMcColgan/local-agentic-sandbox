import fs from "fs";
import path from "path";
import crypto from "crypto";
import manifestJson from "./manifest.json";

export interface BridgeManifest {
  protocolVersion: number;
  bridgeSourceSha256: string;
}

export const PROTOCOL_VERSION = 1;

/**
 * Deterministically computes the SHA-256 digest of source files in host-bridge.
 * Source files are collected, sorted by relative POSIX path, excluding build outputs and generated manifests.
 */
export function computeBridgeSourceSha256(targetDir?: string): string {
  const baseDir = targetDir || __dirname;
  const sourceFiles: string[] = [];

  function scan(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

      // Skip non-source directories and generated files
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "bin" ||
        entry.name === ".git" ||
        entry.name === "manifest.json" ||
        entry.name === "manifest.ts" ||
        relPath.startsWith("dist/") ||
        relPath.startsWith("bin/")
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name.endsWith(".json"))
      ) {
        sourceFiles.push(relPath);
      }
    }
  }

  scan(baseDir);
  sourceFiles.sort();

  const hash = crypto.createHash("sha256");
  for (const rel of sourceFiles) {
    const fullPath = path.join(baseDir, rel);
    const content = fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
    hash.update(`FILE:${rel}\n`);
    hash.update(content);
    hash.update("\n");
  }

  return hash.digest("hex");
}

export function getBridgeManifest(baseDir?: string): BridgeManifest {
  if (baseDir && fs.existsSync(path.join(baseDir, "manifest.json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(baseDir, "manifest.json"), "utf8"));
      if (parsed.protocolVersion && parsed.bridgeSourceSha256) {
        return parsed;
      }
    } catch {}
  }

  if (manifestJson && manifestJson.protocolVersion && manifestJson.bridgeSourceSha256) {
    return manifestJson as BridgeManifest;
  }

  const sha = computeBridgeSourceSha256(baseDir || __dirname);
  return {
    protocolVersion: PROTOCOL_VERSION,
    bridgeSourceSha256: sha
  };
}
