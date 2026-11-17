import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import {
  executeGitVerb,
  isProtectedBranch,
  isValidFeatureBranchName,
  isProhibitedBranchToken,
  isExactPathAllowed,
  parseGitStatusOutput,
  type GitCapability,
  type MergeGrant,
  type BridgeGitConfig
} from "../../host-bridge/gitOps";

describe("Unattended Host Git Operations & Rails (Part 1 & 2)", () => {
  let tempFixtureDir: string;
  let repoDir: string;
  let remoteDir: string;
  let logFile: string;

  before(() => {
    tempFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-fixture-"));
    repoDir = path.join(tempFixtureDir, "repo");
    remoteDir = path.join(tempFixtureDir, "remote.git");
    logFile = path.join(tempFixtureDir, "git-ops.jsonl");

    // Initialize bare remote
    fs.mkdirSync(remoteDir, { recursive: true });
    execSync("git init --bare", { cwd: remoteDir, stdio: "ignore" });

    // Initialize local repo
    fs.mkdirSync(repoDir, { recursive: true });
    execSync("git init -b develop", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.name 'Sandbox Tester'", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.email 'sandbox@tester.local'", { cwd: repoDir, stdio: "ignore" });

    fs.writeFileSync(path.join(repoDir, "README.md"), "# Fixture Repo\n", "utf8");
    execSync("git add README.md", { cwd: repoDir, stdio: "ignore" });
    execSync('git commit -m "Initial commit on develop"', { cwd: repoDir, stdio: "ignore" });

    // Set remote and push develop
    execSync(`git remote add origin "${remoteDir.replace(/\\/g, "/")}"`, { cwd: repoDir, stdio: "ignore" });
    execSync("git push -u origin develop", { cwd: repoDir, stdio: "ignore" });
  });

  after(() => {
    try {
      fs.rmSync(tempFixtureDir, { recursive: true, force: true });
    } catch {}
  });

  const baseConfig: BridgeGitConfig = {
    allowUnattendedGit: true,
    gitRepoAllowlist: {},
    gitOpsLogPath: ""
  };

  beforeEach(() => {
    baseConfig.allowUnattendedGit = true;
    baseConfig.gitRepoAllowlist = {
      "fixture-repo": repoDir
    };
    baseConfig.gitOpsLogPath = logFile;
  });

  describe("Branch & Path Rails (Hermes Laws)", () => {
    it("validates feature branch naming conventions", () => {
      assert.equal(isValidFeatureBranchName("feature/my-feature"), true);
      assert.equal(isValidFeatureBranchName("feature/unattended-git-proof"), true);
      assert.equal(isValidFeatureBranchName("feature/123-fix"), true);
      assert.equal(isValidFeatureBranchName("develop"), false);
      assert.equal(isValidFeatureBranchName("main"), false);
      assert.equal(isValidFeatureBranchName("fix/something"), false);
      assert.equal(isValidFeatureBranchName("random"), false);
    });

    it("refuses branch names with agent/tool tokens", () => {
      assert.equal(isProhibitedBranchToken("feature/subagent-work"), true);
      assert.equal(isProhibitedBranchToken("feature/ai-patch"), true);
      assert.equal(isProhibitedBranchToken("feature/tool-runner"), true);
      assert.equal(isProhibitedBranchToken("feature/bot-update"), true);
      assert.equal(isProhibitedBranchToken("feature/cool-new-feature"), false);
      assert.equal(isProhibitedBranchToken("feature/unattended-git-proof"), false);
    });

    it("protects main, develop, master from direct push/checkout as working branch", () => {
      assert.equal(isProtectedBranch("develop"), true);
      assert.equal(isProtectedBranch("main"), true);
      assert.equal(isProtectedBranch("master"), true);
      assert.equal(isProtectedBranch("feature/xyz"), false);
    });

    it("requires exact relative paths and strictly forbids wildcards or flags", () => {
      assert.equal(isExactPathAllowed("docs/proof.md"), true);
      assert.equal(isExactPathAllowed("src/file.ts"), true);
      assert.equal(isExactPathAllowed("."), false);
      assert.equal(isExactPathAllowed("-A"), false);
      assert.equal(isExactPathAllowed("--all"), false);
      assert.equal(isExactPathAllowed("src/*"), false);
      assert.equal(isExactPathAllowed("src/*.ts"), false);
      assert.equal(isExactPathAllowed("Data/something.json"), false, "Known runtime dir Data/ must not be staged");
      assert.equal(isExactPathAllowed(".agent/thread.json"), false, "Known runtime dir .agent/ must not be staged");
      assert.equal(isExactPathAllowed("logs/run.log"), false, "Known runtime dir logs/ must not be staged");
    });
  });

  describe("Status & Runtime Directory Classification", () => {
    it("parses porcelain status and classifies Data/, logs/, scratch/ as runtime state, not dirty state", () => {
      const rawPorcelain = [
        "?? Data/thread-1.json",
        "?? logs/git-ops.jsonl",
        "?? scratch/temp.txt",
        "?? docs/new-doc.md",
        " M package.json"
      ].join("\n");

      const parsed = parseGitStatusOutput(rawPorcelain);
      assert.equal(parsed.trackedDirty, true);
      assert.deepEqual(parsed.trackedFiles, ["package.json"]);
      assert.deepEqual(parsed.untrackedFiles, ["docs/new-doc.md"]);
      assert.deepEqual(parsed.runtimeDirs, ["Data/thread-1.json", "logs/git-ops.jsonl", "scratch/temp.txt"]);
    });
  });

  describe("Two-Key Authorization & Capability Scoping", () => {
    it("refuses any git verb when bridge flag allowUnattendedGit is false", async () => {
      const configOff = { ...baseConfig, allowUnattendedGit: false };
      const capability: GitCapability = { repo: "fixture-repo", branch: "feature/test-branch" };

      const res = await executeGitVerb("host_git_status", {}, capability, configOff);
      assert.equal(res.success, false);
      assert.match(res.error, /Unattended host git is disabled in bridge configuration/);
    });

    it("refuses when repo is not in the allowlist", async () => {
      const capability: GitCapability = { repo: "unauthorized-repo", branch: "feature/test-branch" };
      const res = await executeGitVerb("host_git_status", {}, capability, baseConfig);
      assert.equal(res.success, false);
      assert.match(res.error, /not in allowlist/);
    });

    it("refuses when caller attempts to retarget to a different branch than granted capability", async () => {
      const capability: GitCapability = { repo: "fixture-repo", branch: "feature/allowed-branch" };
      const res = await executeGitVerb("host_git_push", { branch: "feature/different-branch" }, capability, baseConfig);
      assert.equal(res.success, false);
      assert.match(res.error, /Capability mismatch/);
    });
  });

  describe("Git Verb Lifecycle & Rails (Happy Path & Defenses)", () => {
    const capability: GitCapability = { repo: "fixture-repo", branch: "feature/audit-test" };

    it("host_git_branch_create creates and switches to feature branch, refusing prohibited agent names", async () => {
      // 1. Prohibited name
      const badRes = await executeGitVerb("host_git_branch_create", { branch: "feature/subagent-work" }, { repo: "fixture-repo", branch: "feature/subagent-work" }, baseConfig);
      assert.equal(badRes.success, false);
      assert.match(badRes.error, /prohibited agent\/tool tokens/);

      // 2. Valid name
      const goodRes = await executeGitVerb("host_git_branch_create", { branch: "feature/audit-test", baseRef: "develop" }, capability, baseConfig);
      assert.equal(goodRes.success, true);
      assert.equal(goodRes.branch, "feature/audit-test");

      // Verify branch is active
      const statusRes = await executeGitVerb("host_git_status", {}, capability, baseConfig);
      assert.equal(statusRes.branch, "feature/audit-test");
    });

    it("host_git_add refuses wildcards and runtime directories", async () => {
      const wildcardRes = await executeGitVerb("host_git_add", { paths: ["*"] }, capability, baseConfig);
      assert.equal(wildcardRes.success, false);
      assert.match(wildcardRes.error, /exact relative file paths required/);

      const runtimeRes = await executeGitVerb("host_git_add", { paths: ["Data/test.json"] }, capability, baseConfig);
      assert.equal(runtimeRes.success, false);
      assert.match(runtimeRes.error, /staging runtime directories is forbidden/);
    });

    it("host_git_commit refuses empty commit or staging outside declared scope", async () => {
      // Empty commit
      const emptyRes = await executeGitVerb("host_git_commit", { message: "Empty commit" }, capability, baseConfig);
      assert.equal(emptyRes.success, false);
      assert.match(emptyRes.error, /nothing staged/);

      // Create a valid file, stage, commit
      fs.writeFileSync(path.join(repoDir, "test.txt"), "Proof text\n", "utf8");
      const addRes = await executeGitVerb("host_git_add", { paths: ["test.txt"] }, capability, baseConfig);
      assert.equal(addRes.success, true);

      const commitRes = await executeGitVerb("host_git_commit", { message: "Add proof test.txt" }, capability, baseConfig);
      assert.equal(commitRes.success, true);
      assert.ok(commitRes.headSha);

      // Log must contain commit record
      assert.ok(fs.existsSync(logFile));
      const logContent = fs.readFileSync(logFile, "utf8");
      assert.ok(logContent.includes("host_git_commit"));
    });

    it("host_git_push pushes branch and refuses protected branches", async () => {
      // Push to protected
      const protectedRes = await executeGitVerb("host_git_push", { branch: "develop" }, { repo: "fixture-repo", branch: "develop" }, baseConfig);
      assert.equal(protectedRes.success, false);
      assert.match(protectedRes.error, /direct push to protected branch .* is forbidden/);

      // Push feature branch to origin
      const pushRes = await executeGitVerb("host_git_push", { branch: "feature/audit-test" }, capability, baseConfig);
      assert.equal(pushRes.success, true);

      // Verify remote has the branch
      const remoteBranches = execSync("git branch", { cwd: remoteDir, encoding: "utf8" });
      assert.ok(remoteBranches.includes("feature/audit-test"));
    });

    it("host_git_pull_ff fast-forwards and refuses on dirty tracked tree", async () => {
      // Dirty tracked tree
      fs.writeFileSync(path.join(repoDir, "test.txt"), "Dirty local change\n", "utf8");
      const dirtyPull = await executeGitVerb("host_git_pull_ff", {}, capability, baseConfig);
      assert.equal(dirtyPull.success, false);
      assert.match(dirtyPull.error, /tracked modifications/);

      // Revert dirty change
      execSync("git checkout -- test.txt", { cwd: repoDir, stdio: "ignore" });

      const cleanPull = await executeGitVerb("host_git_pull_ff", {}, capability, baseConfig);
      assert.equal(cleanPull.success, true);
    });
  });

  describe("Part 1.5 Merge Grant Authorization", () => {
    const capability: GitCapability = { repo: "fixture-repo", branch: "feature/audit-test" };

    it("refuses host_git_pr_merge when no merge grant exists", async () => {
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 42 }, capability, baseConfig);
      assert.equal(res.success, false);
      assert.match(res.error, /No merge grant exists/);
    });

    it("refuses when grant PR number or branch does not match", async () => {
      const grant: MergeGrant = { prNumber: 99, consumed: false };
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 42 }, capability, baseConfig, grant);
      assert.equal(res.success, false);
      assert.match(res.error, /PR mismatch/);
    });

    it("refuses when grant is already consumed", async () => {
      const grant: MergeGrant = { prNumber: 42, consumed: true };
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 42 }, capability, baseConfig, grant);
      assert.equal(res.success, false);
      assert.match(res.error, /already been consumed/);
    });

    it("refuses main-based merge unless instruction explicitly names main", async () => {
      const grant: MergeGrant = { prNumber: 42, targetBase: "main", allowMain: false, consumed: false };
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 42 }, capability, baseConfig, grant);
      assert.equal(res.success, false);
      assert.match(res.error, /explicitly approve main/);
    });
  });
});
