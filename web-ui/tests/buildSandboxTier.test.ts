import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  executeInSandboxTier,
  resolveToolchainImage,
  validateSandboxEgress,
  pruneBuildCache,
  BUILD_CACHE_BUDGET_BYTES,
  CACHE_MAX_AGE_DAYS
} from "../lib/sandbox/tierRunner.js";

describe("Phase 1 — Two-Tier Build Sandbox & Resource Budgets Suite", () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-tier-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempWorkspace, { recursive: true, force: true }).catch(() => {});
  });

  it("resolves pre-baked toolchain images for planner-declared toolchains", () => {
    assert.equal(resolveToolchainImage("node:22"), "builder-node:22");
    assert.equal(resolveToolchainImage("python:3.12"), "builder-python:3.12");
    assert.equal(resolveToolchainImage("go"), "builder-go:latest");
    assert.equal(resolveToolchainImage("rust"), "builder-rust:latest");
  });

  it("enforces egress allowlist strictly to package registries in build tier", () => {
    // Allowed package registries
    assert.equal(validateSandboxEgress("build", "https://registry.npmjs.org/next").allowed, true);
    assert.equal(validateSandboxEgress("build", "https://pypi.org/simple/pytest").allowed, true);
    assert.equal(validateSandboxEgress("build", "https://crates.io/api/v1/crates").allowed, true);
    assert.equal(validateSandboxEgress("build", "https://proxy.golang.org").allowed, true);
    assert.equal(validateSandboxEgress("build", "https://github.com/owner/repo.git").allowed, true);

    // Blocked egress in build tier
    const blockedBuild = validateSandboxEgress("build", "https://malicious-exfiltration.net/api");
    assert.equal(blockedBuild.allowed, false);
    assert.ok(blockedBuild.reason?.includes("not in allowlist"));

    // Exec tier blocks ALL egress unconditionally
    const execEgress = validateSandboxEgress("exec", "https://registry.npmjs.org/next");
    assert.equal(execEgress.allowed, false);
    assert.ok(execEgress.reason?.includes("zero internet egress"));
  });

  it("executes build commands in build tier and denies package installations in exec tier", async () => {
    // Create a minimal fixture package.json
    const fixturePackageJson = {
      name: "minimal-fixture-app",
      version: "1.0.0",
      scripts: {
        build: "node -e \"console.log('Build succeeded')\""
      }
    };
    await fs.writeFile(
      path.join(tempWorkspace, "package.json"),
      JSON.stringify(fixturePackageJson, null, 2),
      "utf8"
    );

    // 1. Build tier: writable workspace, toolchain active -> build succeeds
    const buildResult = await executeInSandboxTier({
      tier: "build",
      toolchain: "node:22",
      command: "npm run build",
      workspaceDir: tempWorkspace
    });

    assert.equal(buildResult.status, "SUCCESS");
    assert.equal(buildResult.exitCode, 0);
    assert.ok(buildResult.stdout.includes("Build succeeded"));
    assert.equal(buildResult.securityBoundary.tier, "build");
    assert.equal(buildResult.securityBoundary.networkEgress, "REGISTRY_EGRESS_ALLOWLIST_ONLY");

    // 2. Exec tier: locked down, denies package installation / build operations
    const execResult = await executeInSandboxTier({
      tier: "exec",
      toolchain: "node:22",
      command: "npm install",
      workspaceDir: tempWorkspace
    });

    assert.equal(execResult.status, "SECURITY_DENIED");
    assert.notEqual(execResult.exitCode, 0);
    assert.ok(execResult.error?.includes("Exec tier denies package manager operations"));
    assert.equal(execResult.securityBoundary.tier, "exec");
    assert.equal(execResult.securityBoundary.networkEgress, "BLOCKED");
    assert.equal(execResult.securityBoundary.rootfs, "READ_ONLY");
  });

  it("enforces 20 GB disk budget and prunes cache files older than 7 days", async () => {
    assert.equal(BUILD_CACHE_BUDGET_BYTES, 20 * 1024 * 1024 * 1024);
    assert.equal(CACHE_MAX_AGE_DAYS, 7);

    // Setup mock cache directory
    const cacheDir = path.join(tempWorkspace, "cache");
    await fs.mkdir(cacheDir, { recursive: true });

    // File 1: Fresh cache file (1 day old)
    const freshFile = path.join(cacheDir, "fresh-cache.tar");
    await fs.writeFile(freshFile, "fresh-data", "utf8");

    // File 2: Old cache file (10 days old)
    const oldFile = path.join(cacheDir, "old-cache.tar");
    await fs.writeFile(oldFile, "old-data", "utf8");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, tenDaysAgo, tenDaysAgo);

    const pruneResult = await pruneBuildCache(cacheDir, { maxAgeDays: 7 });

    assert.equal(pruneResult.prunedCount, 1);
    assert.ok(pruneResult.prunedFiles.includes("old-cache.tar"));

    // Fresh file still exists
    const freshExists = await fs.stat(freshFile).then(() => true).catch(() => false);
    assert.equal(freshExists, true);

    // Old file was removed
    const oldExists = await fs.stat(oldFile).then(() => true).catch(() => false);
    assert.equal(oldExists, false);
  });
});
