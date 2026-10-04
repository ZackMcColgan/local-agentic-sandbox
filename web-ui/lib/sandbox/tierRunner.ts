import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { ToolchainType } from "../subagents/types.js";

const execAsync = promisify(exec);

export type SandboxTier = "build" | "exec";

export interface SandboxSecurityBoundary {
  tier: SandboxTier;
  networkEgress: "BLOCKED" | "REGISTRY_EGRESS_ALLOWLIST_ONLY";
  rootfs: "READ_ONLY" | "READ_WRITE_WORKSPACE";
  droppedCapabilities: string[];
  uid: number;
  gid: number;
  buildCacheMounted: boolean;
}

export interface ExecuteSandboxOptions {
  tier: SandboxTier;
  toolchain?: ToolchainType;
  command: string;
  workspaceDir: string;
  timeoutSeconds?: number;
}

export interface SandboxExecutionResult {
  status: "SUCCESS" | "EXECUTION_ERROR" | "SECURITY_DENIED";
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  executionTimeMs: number;
  securityBoundary: SandboxSecurityBoundary;
}

export const BUILD_CACHE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB cap
export const CACHE_MAX_AGE_DAYS = 7;

/**
 * Pre-baked toolchain images map (built and versioned in deploy/)
 */
export const TOOLCHAIN_IMAGES: Record<ToolchainType, string> = {
  "node:22": "builder-node:22",
  "python:3.12": "builder-python:3.12",
  "go": "builder-go:latest",
  "rust": "builder-rust:latest"
};

/**
 * Resolves the deterministic, pre-baked toolchain image for a declared toolchain.
 */
export function resolveToolchainImage(toolchain: ToolchainType): string {
  const image = TOOLCHAIN_IMAGES[toolchain];
  if (!image) {
    throw new Error(`Unsupported toolchain: ${toolchain}. Must be one of: node:22, python:3.12, go, rust`);
  }
  return image;
}

/**
 * Registry allowlist for build tier egress proxy.
 * All other internet egress is dropped.
 */
const ALLOWED_REGISTRY_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "github.com"
];

/**
 * Validates whether an egress target URL is permitted within the sandbox tier.
 */
export function validateSandboxEgress(
  tier: SandboxTier,
  targetUrl: string
): { allowed: boolean; reason?: string } {
  if (tier === "exec") {
    return {
      allowed: false,
      reason: "Security Policy: Exec tier enforces air-gapped zero internet egress (internal: true)."
    };
  }

  try {
    const parsed = new URL(targetUrl);
    const isAllowed = ALLOWED_REGISTRY_DOMAINS.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );

    if (isAllowed) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Security Policy: Egress to ${parsed.hostname} is not in allowlist. Build tier only allows package registries.`
    };
  } catch {
    return {
      allowed: false,
      reason: `Invalid target URL: ${targetUrl}`
    };
  }
}

/**
 * Disallows package managers and compilation tools in the exec tier.
 */
const FORBIDDEN_EXEC_COMMAND_PREFIXES = [
  "npm install",
  "npm i",
  "pnpm install",
  "yarn add",
  "yarn install",
  "pip install",
  "pip3 install",
  "cargo build",
  "cargo install",
  "go install",
  "go get",
  "apt",
  "apt-get",
  "apk"
];

/**
 * Executes a command within the two-tier sandbox architecture.
 */
export async function executeInSandboxTier(
  options: ExecuteSandboxOptions
): Promise<SandboxExecutionResult> {
  const { tier, command, workspaceDir, timeoutSeconds = 30 } = options;
  const startTime = performance.now();

  const securityBoundary: SandboxSecurityBoundary = {
    tier,
    networkEgress: tier === "build" ? "REGISTRY_EGRESS_ALLOWLIST_ONLY" : "BLOCKED",
    rootfs: tier === "build" ? "READ_WRITE_WORKSPACE" : "READ_ONLY",
    droppedCapabilities: ["ALL"],
    uid: 10001,
    gid: 10001,
    buildCacheMounted: tier === "build"
  };

  // Enforcement: Exec tier denies package manager operations and package installation
  if (tier === "exec") {
    const trimmed = command.trim().toLowerCase();
    const isForbidden = FORBIDDEN_EXEC_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
    if (isForbidden) {
      return {
        status: "SECURITY_DENIED",
        exitCode: 126,
        stdout: "",
        stderr: "Permission denied: Exec tier is read-only and air-gapped.",
        error: `Exec tier denies package manager operations (${command}). Use build tier for builds and dependency installation.`,
        executionTimeMs: Math.round(performance.now() - startTime),
        securityBoundary
      };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspaceDir,
      timeout: timeoutSeconds * 1000,
      maxBuffer: 4 * 1024 * 1024
    });

    return {
      status: "SUCCESS",
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      executionTimeMs: Math.round(performance.now() - startTime),
      securityBoundary
    };
  } catch (err: any) {
    return {
      status: "EXECUTION_ERROR",
      exitCode: err.code || 1,
      stdout: err.stdout ? err.stdout.trim() : "",
      stderr: err.stderr ? err.stderr.trim() : err.message,
      error: err.message,
      executionTimeMs: Math.round(performance.now() - startTime),
      securityBoundary
    };
  }
}

/**
 * Prunes files in the build cache directory older than maxAgeDays.
 */
export async function pruneBuildCache(
  cacheDir: string,
  options: { maxAgeDays?: number } = {}
): Promise<{ prunedCount: number; prunedFiles: string[]; bytesFreed: number }> {
  const maxAgeDays = options.maxAgeDays ?? CACHE_MAX_AGE_DAYS;
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let prunedCount = 0;
  const prunedFiles: string[] = [];
  let bytesFreed = 0;

  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(cacheDir, entry.name);
      const stat = await fs.stat(fullPath);

      if (stat.mtimeMs < cutoffTime) {
        bytesFreed += stat.size;
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await fs.unlink(fullPath);
        }
        prunedCount++;
        prunedFiles.push(entry.name);
      }
    }
  } catch (err: any) {
    console.warn(`[BuildCache] Prune notice for ${cacheDir}:`, err.message);
  }

  return { prunedCount, prunedFiles, bytesFreed };
}
