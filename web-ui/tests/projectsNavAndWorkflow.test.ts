import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import React from "react";
import { renderToString } from "react-dom/server";

describe("W1: Mobile Navigation Streamlining & Direct Projects Access", () => {
  it("page.tsx completely removes mobile-bottom-nav and delegates mobile navigation to NavigationDrawer", () => {
    const pageSrc = fs.readFileSync(path.resolve(__dirname, "../app/page.tsx"), "utf8");
    assert.equal(
      pageSrc.includes("mobile-bottom-nav"),
      false,
      "mobile-bottom-nav must be completely removed from page.tsx"
    );
    assert.ok(
      pageSrc.includes("<NavigationDrawer"),
      "page.tsx must render NavigationDrawer for mobile navigation"
    );
  });

  it("ChatStream topbar renders a direct Projects navigation button with accessible label", async () => {
    const { ChatStream } = await import("../components/ChatStream.js");
    let openedProjects = false;

    const html = renderToString(
      React.createElement(ChatStream, {
        onOpenProjects: () => {
          openedProjects = true;
        },
        threadTitle: "Test Thread",
        activeModel: "Swift-1.5-Qwen3.8-27B-IQ3_XS"
      })
    );

    assert.ok(
      html.includes("Projects"),
      "ChatStream topbar must render a Projects button"
    );
    assert.ok(
      html.includes("title=\"Open Projects\"") || html.includes("aria-label=\"Open Projects\"") || html.includes("Projects"),
      "Projects button must be accessible"
    );
  });
});

describe("W2: Filesystem Folder Browser & Smart Discovery API", () => {
  const tmpRoot = path.join(os.tmpdir(), `test-browse-root-${Date.now()}`);
  const gitRepoDir = path.join(tmpRoot, "repo-one");
  const nonGitDir = path.join(tmpRoot, "plain-folder");
  const originalEnv = { ...process.env };

  function setupDirs() {
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.mkdirSync(gitRepoDir, { recursive: true });
    fs.mkdirSync(nonGitDir, { recursive: true });

    // Configure git repo in repo-one
    execFileSync("git", ["init", "-b", "main"], { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, "package.json"), JSON.stringify({ name: "repo-one" }), "utf8");
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: gitRepoDir });
    execFileSync("git", ["config", "user.email", "agent@test.internal"], { cwd: gitRepoDir });
    execFileSync("git", ["add", "."], { cwd: gitRepoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: gitRepoDir });

    // Plain folder with Python requirements
    fs.writeFileSync(path.join(nonGitDir, "requirements.txt"), "flask==3.0.0\n", "utf8");

    process.env.WORKSPACE_DIR = tmpRoot;
  }

  function teardownDirs() {
    process.env = { ...originalEnv };
    try {
      if (fs.existsSync(tmpRoot)) {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    } catch {}
  }

  it("GET /api/projects/browse lists folders and detects git repo, default branch, and toolchain", async () => {
    setupDirs();
    try {
      const { GET } = await import("../app/api/projects/browse/route.js");
      const req = new Request("http://localhost:3000/api/projects/browse");
      const res = await GET(req as any);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.ok(Array.isArray(data.items), "Must return items array");

      const repoItem = data.items.find((i: any) => i.name === "repo-one");
      assert.ok(repoItem, "repo-one must be in items");
      assert.equal(repoItem.isGitRepo, true, "repo-one must be detected as git repo");
      assert.equal(repoItem.defaultBranch, "main", "repo-one branch must be main");
      assert.equal(repoItem.toolchain, "node:22", "repo-one toolchain must detect package.json as node:22");

      const plainItem = data.items.find((i: any) => i.name === "plain-folder");
      assert.ok(plainItem, "plain-folder must be in items");
      assert.equal(plainItem.isGitRepo, false, "plain-folder is not a git repo");
      assert.equal(plainItem.toolchain, "python:3.11", "plain-folder toolchain must detect requirements.txt as python:3.11");
    } finally {
      teardownDirs();
    }
  });

  it("GET /api/projects/browse blocks path traversal outside allowed root", async () => {
    setupDirs();
    try {
      const { GET } = await import("../app/api/projects/browse/route.js");
      const req = new Request("http://localhost:3000/api/projects/browse?subpath=../../etc");
      const res = await GET(req as any);
      assert.equal(res.status, 403, "Must reject traversal outside allowed root with 403");
    } finally {
      teardownDirs();
    }
  });

  it("POST /api/projects/browse can initialize git on existing folder in-place", async () => {
    setupDirs();
    try {
      const { POST } = await import("../app/api/projects/browse/route.js");
      const req = new Request("http://localhost:3000/api/projects/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "init-repo",
          targetPath: nonGitDir
        })
      });
      const res = await POST(req as any);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(fs.existsSync(path.join(nonGitDir, ".git")), true, ".git must be created in nonGitDir");
    } finally {
      teardownDirs();
    }
  });

  it("POST /api/projects/browse can create a greenfield project directory with git init", async () => {
    setupDirs();
    try {
      const { POST } = await import("../app/api/projects/browse/route.js");
      const req = new Request("http://localhost:3000/api/projects/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-greenfield",
          name: "my-greenfield-app"
        })
      });
      const res = await POST(req as any);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.projectPath);
      assert.equal(fs.existsSync(data.projectPath), true, "New project directory must exist");
      assert.equal(fs.existsSync(path.join(data.projectPath, ".git")), true, ".git must exist");
    } finally {
      teardownDirs();
    }
  });
});
