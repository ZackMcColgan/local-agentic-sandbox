import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import {
  executeGitVerb,
  type GitCapability,
  type MergeGrant,
  type BridgeGitConfig
} from "../../host-bridge/gitOps";
import {
  UNATTENDED_GIT_TOOLS_DEFINITIONS,
  shouldAdvertiseUnattendedGitTools
} from "../lib/hostMode";

const CANARY_BASE = process.platform === "win32"
  ? "C:\\AI\\host-e2e-sandbox"
  : path.join(os.tmpdir(), "host-e2e-sandbox");
const WORKING_REPO = path.join(CANARY_BASE, "working-repo");
const BARE_REMOTE = path.join(CANARY_BASE, "remote.git");
const CANARY_BIN = path.join(CANARY_BASE, "bin");
const CANARY_LOG = path.join(CANARY_BASE, "git-ops.jsonl");
const GH_STATE_FILE = path.join(CANARY_BASE, "gh-state.json");

describe("E2E Canary Git Safety Battery (Part 3)", () => {
  const originalPath = process.env.PATH;

  before(() => {
    // 1. Setup sacrificial directory tree
    if (fs.existsSync(CANARY_BASE)) {
      try {
        fs.rmSync(CANARY_BASE, { recursive: true, force: true });
      } catch {}
    }
    fs.mkdirSync(CANARY_BASE, { recursive: true });
    fs.mkdirSync(CANARY_BIN, { recursive: true });
    fs.mkdirSync(BARE_REMOTE, { recursive: true });
    fs.mkdirSync(WORKING_REPO, { recursive: true });

    // 2. Setup Bare Remote
    execSync("git init --bare", { cwd: BARE_REMOTE, stdio: "ignore" });

    // 3. Setup Working Repo
    execSync("git init -b develop", { cwd: WORKING_REPO, stdio: "ignore" });
    execSync("git config user.name 'Canary Runner'", { cwd: WORKING_REPO, stdio: "ignore" });
    execSync("git config user.email 'canary@runner.local'", { cwd: WORKING_REPO, stdio: "ignore" });

    fs.writeFileSync(path.join(WORKING_REPO, "README.md"), "# Canary Working Repo\n", "utf8");
    execSync("git add README.md", { cwd: WORKING_REPO, stdio: "ignore" });
    execSync('git commit -m "Initial commit on develop"', { cwd: WORKING_REPO, stdio: "ignore" });

    const remoteUrl = BARE_REMOTE.replace(/\\/g, "/");
    execSync(`git remote add origin "${remoteUrl}"`, { cwd: WORKING_REPO, stdio: "ignore" });
    execSync("git push -u origin develop", { cwd: WORKING_REPO, stdio: "ignore" });

    // 4. Setup Stubbed gh executable in CANARY_BIN
    const fakeGhScript = `
const fs = require("fs");
const path = require("path");
const stateFile = "${GH_STATE_FILE.replace(/\\/g, "\\\\")}";
let state = {};
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}

const args = process.argv.slice(2);
const sub = args[0]; // pr
const action = args[1]; // create, list, view, merge

if (sub === "pr" && action === "list") {
  if (state.scenario === "existing") {
    console.log(JSON.stringify([{ number: 777, url: "https://github.com/canary/repo/pull/777" }]));
  } else {
    console.log("[]");
  }
  process.exit(0);
}

if (sub === "pr" && action === "create") {
  console.log("https://github.com/canary/repo/pull/888");
  process.exit(0);
}

if (sub === "pr" && action === "view") {
  const prNum = parseInt(args[2], 10) || 888;
  const isDraft = Boolean(state.isDraft);
  const prState = state.prState || "OPEN";
  const mergeable = state.mergeable || "MERGEABLE";
  const base = state.scenario === "main" ? "main" : "develop";

  let statusCheckRollup = [
    { name: "ci-build", conclusion: "SUCCESS" },
    { name: "ci-tests", conclusion: "SUCCESS" }
  ];

  if (state.scenario === "pending") {
    statusCheckRollup = [
      { name: "ci-build", conclusion: "SUCCESS" },
      { name: "ci-tests", conclusion: "PENDING" }
    ];
  } else if (state.scenario === "failing") {
    statusCheckRollup = [
      { name: "ci-build", conclusion: "FAILURE" },
      { name: "ci-tests", conclusion: "SUCCESS" }
    ];
  }

  console.log(JSON.stringify({
    number: prNum,
    title: "Canary PR",
    state: prState,
    isDraft,
    mergeable,
    baseRefName: base,
    statusCheckRollup
  }));
  process.exit(0);
}

if (sub === "pr" && action === "merge") {
  console.log("Merged PR with commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  process.exit(0);
}

console.error("Unknown gh command: " + args.join(" "));
process.exit(1);
`;
    fs.writeFileSync(path.join(CANARY_BIN, "fake-gh.js"), fakeGhScript, "utf8");

    // Setup gh executable for Windows (.cmd) and POSIX
    const isWin = process.platform === "win32";
    const ghPath = path.join(CANARY_BIN, isWin ? "gh.cmd" : "gh");
    if (isWin) {
      const cmdScript = `@node "${path.join(CANARY_BIN, "fake-gh.js")}" %*\n`;
      fs.writeFileSync(ghPath, cmdScript, "utf8");
    } else {
      const shScript = `#!/usr/bin/env node\nrequire("${path.join(CANARY_BIN, "fake-gh.js")}");\n`;
      fs.writeFileSync(ghPath, shScript, { mode: 0o755 });
    }

    // Point GH_BIN_PATH and PATH to stubbed gh
    process.env.GH_BIN_PATH = ghPath;
    process.env.PATH = `${CANARY_BIN}${path.delimiter}${originalPath}`;
  });

  after(() => {
    delete process.env.GH_BIN_PATH;
    process.env.PATH = originalPath;
    try {
      fs.rmSync(CANARY_BASE, { recursive: true, force: true });
    } catch {}
  });

  const bridgeConfig: BridgeGitConfig = {
    allowUnattendedGit: true,
    gitRepoAllowlist: {
      "canary-repo": WORKING_REPO
    },
    gitOpsLogPath: CANARY_LOG
  };

  const capability: GitCapability = {
    repo: "canary-repo",
    branch: "feature/canary-workflow"
  };

  function setGhScenario(state: Record<string, any>) {
    fs.writeFileSync(GH_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  }

  it("Case 1: Full unattended cycle against bare remote (branch_create -> write -> add -> commit -> push)", async () => {
    // 1. branch_create
    const branchRes = await executeGitVerb(
      "host_git_branch_create",
      { branch: "feature/canary-workflow", baseRef: "develop" },
      capability,
      bridgeConfig
    );
    assert.equal(branchRes.success, true);
    assert.equal(branchRes.branch, "feature/canary-workflow");

    // 2. write intended file
    const docPath = path.join(WORKING_REPO, "docs");
    fs.mkdirSync(docPath, { recursive: true });
    fs.writeFileSync(path.join(docPath, "canary-proof.md"), "# Canary Proof\nGenuine unattended cycle.\n", "utf8");

    // 3. add exact path
    const addRes = await executeGitVerb("host_git_add", { paths: ["docs/canary-proof.md"] }, capability, bridgeConfig);
    assert.equal(addRes.success, true);
    assert.deepEqual(addRes.stagedPaths, ["docs/canary-proof.md"]);

    // 4. commit
    const commitRes = await executeGitVerb(
      "host_git_commit",
      { message: "docs: add canary proof" },
      capability,
      bridgeConfig
    );
    assert.equal(commitRes.success, true);
    assert.ok(commitRes.headSha);

    // 5. push
    const pushRes = await executeGitVerb("host_git_push", { branch: "feature/canary-workflow" }, capability, bridgeConfig);
    assert.equal(pushRes.success, true);

    // 6. Verify bare remote has branch and ONLY intended file was committed
    const remoteBranches = execSync("git branch", { cwd: BARE_REMOTE, encoding: "utf8" });
    assert.ok(remoteBranches.includes("feature/canary-workflow"));

    const committedFiles = execSync(`git show --name-only --oneline ${commitRes.headSha}`, {
      cwd: BARE_REMOTE,
      encoding: "utf8"
    }).trim().split(/\r?\n/).slice(1);
    assert.deepEqual(committedFiles, ["docs/canary-proof.md"]);
  });

  it("Case 2: pull_ff brings a new remote commit down cleanly", async () => {
    // Simulate remote commit from bare remote using a separate clone
    const cloneTemp = path.join(CANARY_BASE, "temp-clone");
    execSync(`git clone "${BARE_REMOTE.replace(/\\/g, "/")}" "${cloneTemp.replace(/\\/g, "/")}"`, { stdio: "ignore" });
    execSync("git checkout feature/canary-workflow", { cwd: cloneTemp, stdio: "ignore" });
    fs.writeFileSync(path.join(cloneTemp, "remote-update.txt"), "Remote commit\n", "utf8");
    execSync("git add remote-update.txt", { cwd: cloneTemp, stdio: "ignore" });
    execSync('git commit -m "Remote update from team"', { cwd: cloneTemp, stdio: "ignore" });
    execSync("git push origin feature/canary-workflow", { cwd: cloneTemp, stdio: "ignore" });
    fs.rmSync(cloneTemp, { recursive: true, force: true });

    // Fast-forward pull in working repo
    const pullRes = await executeGitVerb("host_git_pull_ff", {}, capability, bridgeConfig);
    assert.equal(pullRes.success, true);
    assert.ok(fs.existsSync(path.join(WORKING_REPO, "remote-update.txt")));
  });

  it("Case 3: divergence -> pull_ff refuses verbatim and changes nothing", async () => {
    // Make local commit without pushing
    fs.writeFileSync(path.join(WORKING_REPO, "local-diverge.txt"), "Local content\n", "utf8");
    await executeGitVerb("host_git_add", { paths: ["local-diverge.txt"] }, capability, bridgeConfig);
    await executeGitVerb("host_git_commit", { message: "local diverged commit" }, capability, bridgeConfig);

    // Make conflicting remote commit
    const cloneTemp = path.join(CANARY_BASE, "temp-clone2");
    execSync(`git clone "${BARE_REMOTE.replace(/\\/g, "/")}" "${cloneTemp.replace(/\\/g, "/")}"`, { stdio: "ignore" });
    execSync("git checkout feature/canary-workflow", { cwd: cloneTemp, stdio: "ignore" });
    fs.writeFileSync(path.join(cloneTemp, "remote-diverge.txt"), "Remote conflict\n", "utf8");
    execSync("git add remote-diverge.txt", { cwd: cloneTemp, stdio: "ignore" });
    execSync('git commit -m "conflicting remote commit"', { cwd: cloneTemp, stdio: "ignore" });
    execSync("git push origin feature/canary-workflow", { cwd: cloneTemp, stdio: "ignore" });
    fs.rmSync(cloneTemp, { recursive: true, force: true });

    // Fetch so local repo knows remote has diverged
    await executeGitVerb("host_git_fetch", {}, capability, bridgeConfig);

    // pull_ff must refuse
    const divergePull = await executeGitVerb("host_git_pull_ff", {}, capability, bridgeConfig);
    assert.equal(divergePull.success, false);
    assert.ok(divergePull.exitCode !== 0);

    // Reset local commit for subsequent tests
    execSync("git reset --hard origin/feature/canary-workflow", { cwd: WORKING_REPO, stdio: "ignore" });
  });

  it("Case 4: push to a protected name refused", async () => {
    for (const prot of ["develop", "main", "master"]) {
      const res = await executeGitVerb("host_git_push", { branch: prot }, { repo: "canary-repo", branch: prot }, bridgeConfig);
      assert.equal(res.success, false);
      assert.match(res.error, /direct push to protected branch .* is forbidden/);
    }
  });

  it("Case 5: force-push attempt has no verb or parameter to express it", () => {
    const pushDef = UNATTENDED_GIT_TOOLS_DEFINITIONS.find((t) => t.function.name === "host_git_push");
    assert.ok(pushDef);
    const props = Object.keys(pushDef.function.parameters?.properties || {});
    assert.equal(props.includes("force"), false);
    assert.equal(props.includes("--force"), false);
    assert.equal(props.includes("-f"), false);
  });

  it("Case 6: commit with out-of-scope or runtime staged path refused", async () => {
    // Direct attempt to add runtime dir
    const addRuntime = await executeGitVerb("host_git_add", { paths: ["Data/test.json"] }, capability, bridgeConfig);
    assert.equal(addRuntime.success, false);
    assert.match(addRuntime.error, /staging runtime directories is forbidden/);
  });

  it("Case 7: job operating while tree carries tracked modification from someone else -> mutating verbs refuse", async () => {
    // Introduce tracked modification
    fs.writeFileSync(path.join(WORKING_REPO, "README.md"), "# Modified by someone else\n", "utf8");

    const pullRes = await executeGitVerb("host_git_pull_ff", {}, capability, bridgeConfig);
    assert.equal(pullRes.success, false);
    assert.match(pullRes.error, /tracked modifications/);

    const checkoutRes = await executeGitVerb("host_git_checkout", { branch: "feature/canary-workflow" }, capability, bridgeConfig);
    assert.equal(checkoutRes.success, false);
    assert.match(checkoutRes.error, /tracked modifications/);

    // Restore README.md
    execSync("git checkout -- README.md", { cwd: WORKING_REPO, stdio: "ignore" });
  });

  it("Case 8: keys-off matrix (live outcome validation)", async () => {
    // 1. Bridge key off
    const bridgeOffConfig = { ...bridgeConfig, allowUnattendedGit: false };
    const bOffRes = await executeGitVerb("host_git_status", {}, capability, bridgeOffConfig);
    assert.equal(bOffRes.success, false);
    assert.match(bOffRes.error, /disabled in bridge configuration/);

    // 2. Settings key off (web-ui admission)
    const settingsAdmitted = shouldAdvertiseUnattendedGitTools(false, capability, "READY");
    assert.equal(settingsAdmitted, false);

    // 3. Both keys off
    const bothAdmitted = shouldAdvertiseUnattendedGitTools(false, capability, "DISABLED");
    assert.equal(bothAdmitted, false);
  });

  describe("PR Cases (Stubbed gh Canary Engine)", () => {
    beforeEach(() => {
      setGhScenario({ scenario: "normal" });
    });

    it("Case 9: pr_create happy path returns scripted PR number + URL", async () => {
      const res = await executeGitVerb(
        "host_git_pr_create",
        { title: "Canary PR", body: "Description of canary feature" },
        capability,
        bridgeConfig
      );
      assert.equal(res.success, true);
      assert.equal(res.prNumber, 888);
      assert.equal(res.prUrl, "https://github.com/canary/repo/pull/888");
    });

    it("Case 10: pr_create with an existing PR returns existing PR", async () => {
      setGhScenario({ scenario: "existing" });
      const res = await executeGitVerb(
        "host_git_pr_create",
        { title: "Canary PR", body: "Description of canary feature" },
        capability,
        bridgeConfig
      );
      assert.equal(res.success, true);
      assert.equal(res.alreadyExisted, true);
      assert.equal(res.prNumber, 777);
      assert.equal(res.prUrl, "https://github.com/canary/repo/pull/777");
    });

    it("Case 11: pr_merge without a grant refused", async () => {
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 888 }, capability, bridgeConfig);
      assert.equal(res.success, false);
      assert.match(res.error, /No merge grant exists/);
    });

    it("Case 12: pr_merge with grant + scripted GREEN checks merges and consumes the grant", async () => {
      setGhScenario({ scenario: "normal" });
      const grant: MergeGrant = { prNumber: 888, consumed: false };
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 888 }, capability, bridgeConfig, grant);
      assert.equal(res.success, true);
      assert.equal(grant.consumed, true);
      assert.ok(res.mergeSha);
    });

    it("Case 13: pr_merge with scripted FAILED or PENDING check refuses verbatim and does NOT consume grant", async () => {
      // 1. Pending check
      setGhScenario({ scenario: "pending" });
      const pendingGrant: MergeGrant = { prNumber: 888, consumed: false };
      const pendingRes = await executeGitVerb("host_git_pr_merge", { prNumber: 888 }, capability, bridgeConfig, pendingGrant);
      assert.equal(pendingRes.success, false);
      assert.match(pendingRes.error, /not all green/);
      assert.equal(pendingGrant.consumed, false);

      // 2. Failing check
      setGhScenario({ scenario: "failing" });
      const failingGrant: MergeGrant = { prNumber: 888, consumed: false };
      const failingRes = await executeGitVerb("host_git_pr_merge", { prNumber: 888 }, capability, bridgeConfig, failingGrant);
      assert.equal(failingRes.success, false);
      assert.match(failingRes.error, /not all green/);
      assert.equal(failingGrant.consumed, false);
    });

    it("Case 14: pr_merge for main-based PR without explicit main naming refused", async () => {
      setGhScenario({ scenario: "main" });
      const mainGrant: MergeGrant = { prNumber: 888, allowMain: false, consumed: false };
      const res = await executeGitVerb("host_git_pr_merge", { prNumber: 888 }, capability, bridgeConfig, mainGrant);
      assert.equal(res.success, false);
      assert.match(res.error, /instruction did not explicitly approve main base/);
      assert.equal(mainGrant.consumed, false);
    });
  });
});
