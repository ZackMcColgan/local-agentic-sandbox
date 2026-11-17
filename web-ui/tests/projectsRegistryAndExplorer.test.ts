import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GlobalWindow } from "happy-dom";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  initProjectStore,
  listProjects,
  getProject,
  registerProject,
  toggleAllowlist,
  deleteProject,
  validateProjectPath,
  ProjectRecord
} from "../lib/projects/projectStore";
import {
  assertAllowedProjectPath,
  getProjectTree,
  readProjectFile
} from "../lib/projects/projectGit";
import { GET as getProjects, POST as postProjects, PATCH as patchProjects } from "../app/api/projects/route";
import { GET as getProjectFiles } from "../app/api/projects/[id]/files/route";
import { ProjectsView } from "../components/ProjectsView";
import { closeSharedRunLedger } from "../lib/ledger/runLedger";

describe("PHASE 1: Projects Registry, Allowlist Gate & Read-Only Explorer", () => {
  let tempDir: string;
  let testRepoDir: string;
  let outsideDir: string;
  let win: GlobalWindow;
  let container: HTMLDivElement;
  let root: Root | null = null;
  let origDbPath: string | undefined;

  beforeEach(() => {
    origDbPath = process.env.RUN_LEDGER_DB_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-test-"));
    process.env.RUN_LEDGER_DB_PATH = path.join(tempDir, "test-projects-runs.db");
    closeSharedRunLedger();

    testRepoDir = path.join(tempDir, "test-repo");
    outsideDir = path.join(tempDir, "outside");
    fs.mkdirSync(testRepoDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Initialize test repo structure
    fs.mkdirSync(path.join(testRepoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, "node_modules", "somepkg"), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, ".git"), { recursive: true });

    fs.writeFileSync(path.join(testRepoDir, "src", "index.ts"), "export const hello = 'world';", "utf8");
    fs.writeFileSync(path.join(testRepoDir, "README.md"), "# Test Repo\nSample content", "utf8");
    fs.writeFileSync(path.join(testRepoDir, "node_modules", "somepkg", "index.js"), "module.exports = {};", "utf8");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "classified data", "utf8");

    // Happy DOM setup
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    win = new GlobalWindow({ url: "http://localhost:3000" });
    globalThis.window = win as any;
    globalThis.document = win.document as any;
    globalThis.localStorage = win.localStorage as any;

    const div = win.document.createElement("div");
    win.document.body.appendChild(div);
    container = div as unknown as HTMLDivElement;
  });

  afterEach(() => {
    closeSharedRunLedger();
    if (origDbPath !== undefined) {
      process.env.RUN_LEDGER_DB_PATH = origDbPath;
    } else {
      delete process.env.RUN_LEDGER_DB_PATH;
    }
    if (root) {
      try {
        root.unmount();
      } catch {}
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("Item 1: Project Registration, Canonicalization & CRUD", () => {
    it("canonicalizes path, persists in SQLite, and lists registered project", () => {
      const canonicalExpected = fs.realpathSync(testRepoDir);
      const project = registerProject({
        name: "Test Repository",
        rootPath: testRepoDir
      });

      assert.ok(project.project_id, "Generated a project_id");
      assert.equal(project.name, "Test Repository");
      assert.equal(project.root_path, canonicalExpected);
      assert.equal(project.base_branch, "develop");
      assert.equal(project.toolchain, "node:22");
      assert.equal(project.allowlisted, 1);
      assert.equal(project.active_task_id, null);

      const projects = listProjects();
      const found = projects.find((p) => p.project_id === project.project_id);
      assert.ok(found, "Project listed in store");
      assert.equal(found?.root_path, canonicalExpected);

      const retrieved = getProject(project.project_id);
      assert.ok(retrieved);
      assert.equal(retrieved?.name, "Test Repository");
    });

    it("rejects duplicate path registration", () => {
      registerProject({
        name: "First Registration",
        rootPath: testRepoDir
      });

      assert.throws(() => {
        registerProject({
          name: "Second Registration",
          rootPath: testRepoDir
        });
      }, /already registered|UNIQUE constraint/i);
    });

    it("toggles allowlist and deletes project", () => {
      const project = registerProject({
        name: "Toggle Test",
        rootPath: testRepoDir
      });

      const toggledOff = toggleAllowlist(project.project_id, false);
      assert.equal(toggledOff.allowlisted, 0);

      const toggledOn = toggleAllowlist(project.project_id, true);
      assert.equal(toggledOn.allowlisted, 1);

      const deleted = deleteProject(project.project_id);
      assert.equal(deleted, true);
      assert.equal(getProject(project.project_id), null);
    });
  });

  describe("Item 2: Path Validator rejects roots, system dirs & invalid paths", () => {
    it("rejects non-existent path", () => {
      const nonExistent = path.join(tempDir, "does-not-exist");
      const res = validateProjectPath(nonExistent);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /does not exist/i);
    });

    it("rejects non-directory path (file)", () => {
      const filePath = path.join(testRepoDir, "README.md");
      const res = validateProjectPath(filePath);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /not a directory/i);
    });

    it("rejects filesystem roots (/ and C:\\)", () => {
      const rootPosix = validateProjectPath("/");
      assert.equal(rootPosix.valid, false);
      assert.match(rootPosix.error || "", /root/i);

      if (process.platform === "win32") {
        const rootWin = validateProjectPath("C:\\");
        assert.equal(rootWin.valid, false);
        assert.match(rootWin.error || "", /root/i);
      }
    });

    it("rejects system directories (/etc, C:\\Windows, Program Files)", () => {
      const etcRes = validateProjectPath("/etc");
      assert.equal(etcRes.valid, false);

      const procRes = validateProjectPath("/proc");
      assert.equal(procRes.valid, false);

      if (process.platform === "win32") {
        const winDir = process.env.SystemRoot || "C:\\Windows";
        const winRes = validateProjectPath(winDir);
        assert.equal(winRes.valid, false);

        const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
        const progRes = validateProjectPath(progFiles);
        assert.equal(progRes.valid, false);
      }
    });
  });

  describe("Item 3: assertAllowedProjectPath Gate", () => {
    it("allows valid relative path in allowlisted project", () => {
      const project = registerProject({
        name: "Gate Allow Test",
        rootPath: testRepoDir
      });

      const allowedPath = assertAllowedProjectPath(project, "src/index.ts");
      assert.equal(allowedPath, fs.realpathSync(path.join(testRepoDir, "src", "index.ts")));
    });

    it("rejects path traversal attempting to escape project root", () => {
      const project = registerProject({
        name: "Gate Traversal Test",
        rootPath: testRepoDir
      });

      assert.throws(() => {
        assertAllowedProjectPath(project, "../../outside/secret.txt");
      }, /outside project root|traversal/i);

      assert.throws(() => {
        assertAllowedProjectPath(project, "../test-repo/../../etc/passwd");
      }, /outside project root|traversal/i);
    });

    it("rejects symlink escape pointing outside project root", () => {
      const project = registerProject({
        name: "Symlink Escape Test",
        rootPath: testRepoDir
      });

      const linkPath = path.join(testRepoDir, "src", "escape-link");
      try {
        fs.symlinkSync(outsideDir, linkPath, "junction");
      } catch {
        // Skip on environments without symlink permissions
        return;
      }

      assert.throws(() => {
        assertAllowedProjectPath(project, "src/escape-link/secret.txt");
      }, /outside project root|symlink escape|traversal/i);
    });

    it("rejects all operations when allowlisted is 0", () => {
      const project = registerProject({
        name: "Revoked Test",
        rootPath: testRepoDir
      });

      toggleAllowlist(project.project_id, false);
      const revokedProject = getProject(project.project_id)!;
      assert.equal(revokedProject.allowlisted, 0);

      assert.throws(() => {
        assertAllowedProjectPath(revokedProject, "src/index.ts");
      }, /revoked|not allowlisted/i);
    });
  });

  describe("Item 4: Explorer Tree, File Reading & API Routes", () => {
    it("getProjectTree skips node_modules, .git, and returns clean structure", () => {
      const project = registerProject({
        name: "Tree Test",
        rootPath: testRepoDir
      });

      const tree = getProjectTree(project);
      const paths = tree.map((t) => t.path);

      assert.ok(paths.includes("src/index.ts") || paths.includes("src\\index.ts") || paths.some((p) => p.endsWith("index.ts")));
      assert.ok(paths.includes("README.md") || paths.some((p) => p.endsWith("README.md")));
      assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules must be excluded");
      assert.ok(!paths.some((p) => p.includes(".git")), ".git must be excluded");
    });

    it("readProjectFile reads file content safely", () => {
      const project = registerProject({
        name: "Read Test",
        rootPath: testRepoDir
      });

      const res = readProjectFile(project, "src/index.ts");
      assert.equal(res.content, "export const hello = 'world';");
      assert.ok(res.size > 0);
    });

    it("API routes: GET /api/projects, POST /api/projects, PATCH allowlist", async () => {
      // POST new project
      const postReq = new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "API Created Project",
          rootPath: testRepoDir
        })
      });

      const postRes = await postProjects(postReq);
      assert.equal(postRes.status, 201);
      const postData = await postRes.json();
      assert.ok(postData.project);
      assert.equal(postData.project.name, "API Created Project");

      // GET list
      const getRes = await getProjects();
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.projects));
      assert.ok(getData.projects.some((p: any) => p.project_id === postData.project.project_id));

      // PATCH toggle allowlist
      const patchReq = new Request("http://localhost:3000/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: postData.project.project_id,
          allowlisted: false
        })
      });
      const patchRes = await patchProjects(patchReq);
      assert.equal(patchRes.status, 200);
      const patchData = await patchRes.json();
      assert.equal(patchData.project.allowlisted, 0);
    });

    it("API files route: returns 403 on revoked or traversal, 200 on valid tree/file", async () => {
      const project = registerProject({
        name: "Files API Test",
        rootPath: testRepoDir
      });

      // 1. Valid tree request
      const treeReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/files`);
      const treeRes = await getProjectFiles(treeReq, { params: Promise.resolve({ id: project.project_id }) });
      assert.equal(treeRes.status, 200);
      const treeData = await treeRes.json();
      assert.ok(Array.isArray(treeData.tree));

      // 2. Valid file read request
      const fileReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/files?path=src/index.ts`);
      const fileRes = await getProjectFiles(fileReq, { params: Promise.resolve({ id: project.project_id }) });
      assert.equal(fileRes.status, 200);
      const fileData = await fileRes.json();
      assert.equal(fileData.content, "export const hello = 'world';");

      // 3. Traversal attack -> 403
      const traversalReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/files?path=../../outside/secret.txt`);
      const traversalRes = await getProjectFiles(traversalReq, { params: Promise.resolve({ id: project.project_id }) });
      assert.equal(traversalRes.status, 403);

      // 4. Revoked project -> 403
      toggleAllowlist(project.project_id, false);
      const revokedReq = new Request(`http://localhost:3000/api/projects/${project.project_id}/files?path=src/index.ts`);
      const revokedRes = await getProjectFiles(revokedReq, { params: Promise.resolve({ id: project.project_id }) });
      assert.equal(revokedRes.status, 403);
    });
  });

  describe("Item 5: ProjectsView Component UI Rendering", () => {
    it("renders project cards, allowlist badge, and + Register Folder action", async () => {
      const mockProject: ProjectRecord = {
        project_id: "proj_test_123",
        name: "Acme Web App",
        root_path: "/workspace/projects/acme",
        base_branch: "develop",
        toolchain: "node:22",
        allowlisted: 1,
        active_task_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(ProjectsView, {
            projects: [mockProject],
            selectedProjectId: mockProject.project_id,
            onSelectProject: () => {},
            onRegisterProject: async () => {},
            onToggleAllowlist: async () => {},
            onOpenDrawer: () => {}
          })
        );
      });

      const html = container.innerHTML;
      assert.ok(html.includes("Acme Web App"), "Renders project card name");
      assert.ok(html.includes("Register Folder") || html.includes("Register Project"), "Renders register button");
      assert.ok(html.includes("Allowlisted") || html.includes("Active"), "Renders allowlist badge/status");
      assert.ok(html.includes("node:22"), "Renders toolchain badge");
    });
  });
});
