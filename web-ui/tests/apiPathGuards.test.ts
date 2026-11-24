import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";

import { GET as filesGet } from "../app/api/files/route.js";
import { ThreadStore } from "../lib/threads/threadStore.js";
import {
  GET as threadGet,
  POST as threadPost,
  DELETE as threadDelete,
} from "../app/api/threads/[id]/route.js";
import {
  recordObservedPattern,
  approveSkillCandidate,
  rejectSkillCandidate,
} from "../lib/subagents/skillGate.js";
import { POST as skillsPost } from "../app/api/skills/route.js";
import { GET as browseGet, POST as browsePost } from "../app/api/projects/browse/route.js";
import { POST as deployPost } from "../app/api/deploy/route.js";
import { SelfDeployPipeline } from "../lib/deploy/selfDeploy.js";
import { getProjectDiffSummary, revertProjectFile } from "../lib/projects/projectGit.js";
import type { ProjectRecord } from "../lib/projects/projectStore.js";

function createSymlinkOrJunction(target: string, linkPath: string, isDir: boolean): boolean {
  try {
    fs.symlinkSync(
      target,
      linkPath,
      isDir ? (process.platform === "win32" ? "junction" : "dir") : "file"
    );
    return true;
  } catch {
    if (process.platform === "win32" && !isDir) {
      return false;
    }
    throw new Error(`Failed to create symlink ${linkPath} -> ${target}`);
  }
}

describe("R6: API Path Confinement, ID Validation, and Deploy/Git Parameter Guards", () => {
  describe("1. GET /api/files path confinement", () => {
    it("rejects /api/files?path=/etc/hosts and non-workspace absolute paths with 400/403", async () => {
      const resEtcHosts = await filesGet(
        new NextRequest("http://localhost:3000/api/files?path=/etc/hosts")
      );
      assert.ok(
        resEtcHosts.status === 400 || resEtcHosts.status === 403,
        `Expected 400/403 for /etc/hosts, got ${resEtcHosts.status}`
      );

      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "r6-files-outside-"));
      try {
        const outsideFile = path.join(outsideDir, "secret.txt");
        fs.writeFileSync(outsideFile, "top-secret", "utf8");

        const resOutside = await filesGet(
          new NextRequest(`http://localhost:3000/api/files?path=${encodeURIComponent(outsideFile)}`)
        );
        assert.ok(
          resOutside.status === 400 || resOutside.status === 403,
          `Expected 400/403 for outside absolute path, got ${resOutside.status}`
        );
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("does not expose process.cwd() or parent root when WORKSPACE_DIR and EXPLORER_ROOT are isolated", async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "r6-files-iso-"));
      const wsDir = path.join(tmpRoot, "workspace");
      const explorerDir = path.join(tmpRoot, "explorer");
      fs.mkdirSync(wsDir, { recursive: true });
      fs.mkdirSync(explorerDir, { recursive: true });

      const cwdFixture = path.join(process.cwd(), "r6-cwd-probe-only.txt");
      fs.writeFileSync(cwdFixture, "should-not-be-served-via-cwd", "utf8");

      const prevWs = process.env.WORKSPACE_DIR;
      const prevExp = process.env.EXPLORER_ROOT;
      const prevThreads = process.env.THREADS_DIR;
      process.env.WORKSPACE_DIR = wsDir;
      process.env.EXPLORER_ROOT = explorerDir;
      process.env.THREADS_DIR = path.join(wsDir, ".agent", "threads");

      try {
        const res = await filesGet(
          new NextRequest("http://localhost:3000/api/files?path=r6-cwd-probe-only.txt")
        );
        assert.notEqual(
          res.status,
          200,
          "Files in process.cwd() must NOT be served once cwd is removed from candidateRoots"
        );
      } finally {
        if (prevWs === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = prevWs;
        if (prevExp === undefined) delete process.env.EXPLORER_ROOT;
        else process.env.EXPLORER_ROOT = prevExp;
        if (prevThreads === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = prevThreads;
        fs.rmSync(cwdFixture, { force: true });
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("rejects symlinks inside workspace that escape the allowed root", async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "r6-files-sym-"));
      const wsDir = path.join(tmpRoot, "workspace");
      const outsideDir = path.join(tmpRoot, "outside");
      fs.mkdirSync(wsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "leak.txt"), "secret-content", "utf8");

      const prevWs = process.env.WORKSPACE_DIR;
      const prevExp = process.env.EXPLORER_ROOT;
      const prevThreads = process.env.THREADS_DIR;
      process.env.WORKSPACE_DIR = wsDir;
      process.env.EXPLORER_ROOT = wsDir;
      process.env.THREADS_DIR = path.join(wsDir, ".agent", "threads");

      try {
        const linkDir = path.join(wsDir, "escape-dir");
        if (createSymlinkOrJunction(outsideDir, linkDir, true)) {
          const res = await filesGet(
            new NextRequest("http://localhost:3000/api/files?path=escape-dir/leak.txt")
          );
          assert.ok(
            res.status === 400 || res.status === 403,
            `Expected 400/403 for symlink escape, got ${res.status}`
          );
        }
      } finally {
        if (prevWs === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = prevWs;
        if (prevExp === undefined) delete process.env.EXPLORER_ROOT;
        else process.env.EXPLORER_ROOT = prevExp;
        if (prevThreads === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = prevThreads;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe("2. ThreadStore & /api/threads/[id] ID validation", () => {
    it("ThreadStore.getFilePath throws on traversal and invalid thread IDs", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r6-threadstore-"));
      try {
        const store = new ThreadStore(tmpDir);
        for (const badId of [
          "../board/board",
          "..%2Fboard%2Fboard",
          "..",
          ".",
          "foo..bar",
          "a/b",
          "a\\b",
          "",
        ]) {
          assert.throws(
            () => store.getFilePath(badId),
            /invalid|traversal/i,
            `Expected getFilePath(${JSON.stringify(badId)}) to throw`
          );
        }
        assert.ok(store.getFilePath("thread-valid_1.0").endsWith("thread-valid_1.0.json"));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("GET, POST, and DELETE /api/threads/[id] reject traversal IDs with HTTP 400 without touching outside files", async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "r6-threads-api-"));
      const threadsDir = path.join(tmpRoot, "threads");
      const boardDir = path.join(tmpRoot, "board");
      fs.mkdirSync(threadsDir, { recursive: true });
      fs.mkdirSync(boardDir, { recursive: true });
      const boardFile = path.join(boardDir, "board.json");
      fs.writeFileSync(boardFile, JSON.stringify({ items: [] }), "utf8");

      const prevThreads = process.env.THREADS_DIR;
      process.env.THREADS_DIR = threadsDir;

      try {
        for (const badId of ["..%2Fboard%2Fboard", "../board/board"]) {
          const getRes = await threadGet(
            new Request(`http://localhost:3000/api/threads/${badId}`),
            { params: Promise.resolve({ id: badId }) }
          );
          assert.equal(getRes.status, 400, `GET ${badId} must return 400`);

          const postRes = await threadPost(
            new Request(`http://localhost:3000/api/threads/${badId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "rename", title: "hacked" }),
            }),
            { params: Promise.resolve({ id: badId }) }
          );
          assert.equal(postRes.status, 400, `POST ${badId} must return 400`);

          const delRes = await threadDelete(
            new Request(`http://localhost:3000/api/threads/${badId}`, { method: "DELETE" }),
            { params: Promise.resolve({ id: badId }) }
          );
          assert.equal(delRes.status, 400, `DELETE ${badId} must return 400`);
        }

        assert.equal(fs.existsSync(boardFile), true, "board.json must remain untouched");
      } finally {
        if (prevThreads === undefined) delete process.env.THREADS_DIR;
        else process.env.THREADS_DIR = prevThreads;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe("3. skillGate & POST /api/skills candidateId validation", () => {
    it("skillGate rejects id: '../../etc/evil' and POST /api/skills returns 400", async () => {
      const tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "r6-skills-"));
      const prevSkills = process.env.SKILLS_DIR;
      process.env.SKILLS_DIR = tmpSkillsDir;

      try {
        assert.throws(
          () =>
            recordObservedPattern(
              "../../etc/evil",
              { title: "Evil", solutionSummary: "Nope" },
              { skillsDir: tmpSkillsDir }
            ),
          /invalid/i
        );

        const appRes = approveSkillCandidate("../../etc/evil", { skillsDir: tmpSkillsDir });
        assert.equal(appRes.promoted, false);
        assert.match(appRes.error || "", /invalid/i);

        const rejRes = rejectSkillCandidate("../../etc/evil", { skillsDir: tmpSkillsDir });
        assert.equal(rejRes.rejected, false);
        assert.match(rejRes.error || "", /invalid/i);

        for (const action of ["propose", "approve", "reject"]) {
          const req = new NextRequest("http://localhost:3000/api/skills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, id: "../../etc/evil", title: "Evil" }),
          });
          const res = await skillsPost(req);
          assert.equal(
            res.status,
            400,
            `POST /api/skills (${action}) must reject invalid id with 400`
          );
        }
      } finally {
        if (prevSkills === undefined) delete process.env.SKILLS_DIR;
        else process.env.SKILLS_DIR = prevSkills;
        fs.rmSync(tmpSkillsDir, { recursive: true, force: true });
      }
    });
  });

  describe("4. /api/projects/browse boundary confinement", () => {
    it("rejects sibling-prefix directories and symlink escapes with 403", async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "r6-browse-"));
      const wsDir = path.join(tmpRoot, "workspace");
      const siblingDir = path.join(tmpRoot, "workspace-evil");
      const outsideDir = path.join(tmpRoot, "outside");
      fs.mkdirSync(wsDir, { recursive: true });
      fs.mkdirSync(siblingDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const prevWs = process.env.WORKSPACE_DIR;
      process.env.WORKSPACE_DIR = wsDir;

      try {
        // Sibling-prefix via relative subpath
        const sibRelRes = await browseGet(
          new NextRequest("http://localhost:3000/api/projects/browse?subpath=../workspace-evil")
        );
        assert.equal(sibRelRes.status, 403, "Sibling-prefix relative subpath must return 403");

        // Sibling-prefix via absolute subpath
        const sibAbsRes = await browseGet(
          new NextRequest(
            `http://localhost:3000/api/projects/browse?subpath=${encodeURIComponent(siblingDir)}`
          )
        );
        assert.equal(sibAbsRes.status, 403, "Sibling-prefix absolute subpath must return 403");

        // Symlink/junction escape
        const escapeLink = path.join(wsDir, "escape-link");
        createSymlinkOrJunction(outsideDir, escapeLink, true);
        const symRes = await browseGet(
          new NextRequest("http://localhost:3000/api/projects/browse?subpath=escape-link")
        );
        assert.equal(symRes.status, 403, "Symlink escape inside workspace must return 403");

        // POST init-repo with sibling-prefix outside allowed root (when not in tmpdir — test symlink escape inside tmpdir)
        const outsideLink = path.join(wsDir, "evil-init-link");
        if (!fs.existsSync(outsideLink)) {
          createSymlinkOrJunction(outsideDir, outsideLink, true);
        }
        const postSibRes = await browsePost(
          new NextRequest("http://localhost:3000/api/projects/browse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "init-repo",
              targetPath: path.join("C:", "r6-outside-nonexistent"),
            }),
          })
        );
        assert.equal(postSibRes.status, 403);
      } finally {
        if (prevWs === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = prevWs;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe("5. POST /api/deploy origin & parameter guards", () => {
    it("rejects cross-origin and missing-origin requests across all POST /api/deploy branches with 403", async () => {
      const payloads = [
        { action: "toggleKillSwitch", enabled: true },
        { action: "deployBuild", taskId: "task-1" },
        { action: "executeSelfDeploy", branchName: "feat/test", dryRun: true },
        { action: "executeDeploy", branchName: "feat/test", dryRun: true },
      ];

      for (const payload of payloads) {
        const crossReq = new NextRequest("http://localhost:3000/api/deploy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:3000",
            origin: "http://evil.example.com",
          },
          body: JSON.stringify(payload),
        });
        const crossRes = await deployPost(crossReq);
        assert.equal(crossRes.status, 403, `Cross-origin ${payload.action} must return 403`);

        const missingOriginReq = new NextRequest("http://localhost:3000/api/deploy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            host: "localhost:3000",
          },
          body: JSON.stringify(payload),
        });
        const missingRes = await deployPost(missingOriginReq);
        assert.equal(missingRes.status, 403, `Missing-origin ${payload.action} must return 403`);
      }
    });

    it("rejects invalid branchName, imageTag, and hostAddress with 400 on same-origin POST /api/deploy", async () => {
      const prevEnabled = process.env.SELF_DEPLOY_ENABLED;
      process.env.SELF_DEPLOY_ENABLED = "true";

      const postSameOrigin = (body: Record<string, unknown>) =>
        deployPost(
          new NextRequest("http://localhost:3000/api/deploy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              host: "localhost:3000",
              origin: "http://localhost:3000",
            },
            body: JSON.stringify({
              action: "executeSelfDeploy",
              dryRun: true,
              skipPreRollout: true,
              ...body,
            }),
          })
        );

      try {
        for (const badBranch of [
          "--upload-pack=evil",
          "-f",
          "feat/a..b",
          "feat/a;id",
          "feat/a b",
        ]) {
          const res = await postSameOrigin({ branchName: badBranch });
          assert.equal(res.status, 400, `Invalid branchName '${badBranch}' must return 400`);
        }

        for (const badTag of [
          "--build-arg=evil",
          "web-ui:latest;rm",
          "web-ui:$(id)",
          "web-ui:a b",
        ]) {
          const res = await postSameOrigin({ branchName: "feat/ok", imageTag: badTag });
          assert.equal(res.status, 400, `Invalid imageTag '${badTag}' must return 400`);
        }

        for (const badHost of [
          "evil.com/path",
          "user@127.0.0.1",
          "evil.com?x=1",
          "evil.com#frag",
          "http://evil.com",
          "127.0.0.1:8080",
          "evil.com bad",
        ]) {
          const res = await postSameOrigin({ branchName: "feat/ok", hostAddress: badHost });
          assert.equal(res.status, 400, `Invalid hostAddress '${badHost}' must return 400`);
        }
      } finally {
        if (prevEnabled === undefined) delete process.env.SELF_DEPLOY_ENABLED;
        else process.env.SELF_DEPLOY_ENABLED = prevEnabled;
      }
    });

    it("SelfDeployPipeline validates parameters and passes '--' before branchName in git merge", async () => {
      const ran: Array<{ file: string; args: string[] }> = [];
      const pipeline = new SelfDeployPipeline({
        enabled: true,
        commandRunner: async (file, args) => {
          ran.push({ file, args });
          if (file === "ctr" && args.includes("ls")) {
            return { exitCode: 0, stdout: `${file} ${args.join(" ")}\n`, stderr: "" };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "" };
        },
        healthChecker: async () => ({ status: 200, ok: true }),
      });

      await assert.rejects(
        () =>
          pipeline.executeDeploy({
            branchName: "--upload-pack=evil",
            previousSha: "develop",
            newSha: "abc1234",
          }),
        /invalid/i
      );
      assert.equal(ran.length, 0, "No command may execute on invalid branchName");

      await pipeline.executeDeploy({
        branchName: "feat/task-safe",
        previousSha: "develop",
        newSha: "abc1234",
        imageTag: "local-agentic-sandbox-web-ui:v1.0.0",
        hostAddress: "127.0.0.1",
      });

      const mergeCall = ran.find((c) => c.file === "git" && c.args[0] === "merge");
      assert.ok(mergeCall, "git merge must be invoked");
      assert.deepEqual(
        mergeCall.args,
        ["merge", "--no-ff", "--", "feat/task-safe"],
        "git merge must pass '--' separator before branchName"
      );
    });
  });

  describe("6. projectGit.ts baseSha ref guard", () => {
    it("rejects invalid baseSha values like '--option' or shell/flag injection", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r6-projgit-"));
      try {
        execFileSync("git", ["init", "-b", "develop"], { cwd: tmpDir });
        execFileSync("git", ["config", "user.email", "test@local.internal"], { cwd: tmpDir });
        execFileSync("git", ["config", "user.name", "Tester"], { cwd: tmpDir });
        fs.writeFileSync(path.join(tmpDir, "README.md"), "hello\n", "utf8");
        execFileSync("git", ["add", "."], { cwd: tmpDir });
        execFileSync("git", ["commit", "-m", "init"], { cwd: tmpDir });

        const project: ProjectRecord = {
          project_id: "proj-r6",
          name: "r6-proj",
          root_path: tmpDir,
          base_branch: "develop",
          toolchain: "node:22",
          allowlisted: 1,
          active_task_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        for (const badRef of [
          "--output=/tmp/pwn",
          "-p",
          "--exec=id",
          "HEAD;id",
          "main..evil",
          "a b",
        ]) {
          assert.throws(
            () => getProjectDiffSummary(project, "task-1", badRef),
            /invalid/i,
            `getProjectDiffSummary must reject invalid baseSha '${badRef}'`
          );
          assert.throws(
            () => revertProjectFile(project, "task-1", "README.md", badRef),
            /invalid/i,
            `revertProjectFile must reject invalid baseSha '${badRef}'`
          );
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
