import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

export const dynamic = "force-dynamic";

function getAllowedRoot(): string {
  if (process.env.WORKSPACE_DIR) {
    return path.resolve(process.env.WORKSPACE_DIR);
  }
  const defaultDir = path.resolve(process.cwd(), "workspace");
  if (!fs.existsSync(defaultDir)) {
    try {
      fs.mkdirSync(defaultDir, { recursive: true });
    } catch {}
  }
  return defaultDir;
}

function detectToolchain(dirPath: string): string {
  try {
    if (fs.existsSync(path.join(dirPath, "package.json"))) return "node:22";
    if (fs.existsSync(path.join(dirPath, "Cargo.toml"))) return "rust:latest";
    if (fs.existsSync(path.join(dirPath, "pyproject.toml")) || fs.existsSync(path.join(dirPath, "requirements.txt"))) {
      return "python:3.11";
    }
    if (fs.existsSync(path.join(dirPath, "go.mod"))) return "golang:latest";
  } catch {}
  return "node:22";
}

function detectDefaultBranch(dirPath: string): string {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dirPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {}
  return "main";
}

export async function GET(req: NextRequest) {
  try {
    const allowedRoot = getAllowedRoot();
    const url = new URL(req.url);
    const subpath = url.searchParams.get("subpath") || "";

    const candidate = subpath ? path.resolve(allowedRoot, subpath) : allowedRoot;
    const rootNorm = path.normalize(allowedRoot);
    const candidateNorm = path.normalize(candidate);

    if (!candidateNorm.startsWith(rootNorm)) {
      return NextResponse.json({ error: "Access forbidden: directory traversal" }, { status: 403 });
    }

    if (!fs.existsSync(candidateNorm)) {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const stat = fs.statSync(candidateNorm);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const entries = fs.readdirSync(candidateNorm, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".agent") continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;

      if (entry.isDirectory()) {
        const full = path.join(candidateNorm, entry.name);
        const isGitRepo = fs.existsSync(path.join(full, ".git"));
        const defaultBranch = isGitRepo ? detectDefaultBranch(full) : "main";
        const toolchain = detectToolchain(full);

        items.push({
          name: entry.name,
          path: full,
          relPath: path.relative(allowedRoot, full).replace(/\\/g, "/"),
          isGitRepo,
          defaultBranch,
          toolchain
        });
      }
    }

    // Sort: git repos first, then alphabetical
    items.sort((a, b) => {
      if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const isAtRoot = candidateNorm === rootNorm;
    const parentPath = isAtRoot ? null : path.dirname(candidateNorm);

    return NextResponse.json({
      allowedRoot,
      currentPath: candidateNorm,
      relPath: path.relative(allowedRoot, candidateNorm).replace(/\\/g, "/") || ".",
      isAtRoot,
      parentPath,
      items
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const allowedRoot = getAllowedRoot();
    const body = await req.json();
    const { action, targetPath, name } = body;

    if (action === "init-repo") {
      if (!targetPath) {
        return NextResponse.json({ error: "Missing targetPath" }, { status: 400 });
      }

      const norm = path.normalize(path.resolve(targetPath));
      if (!norm.startsWith(path.normalize(allowedRoot)) && !norm.startsWith(path.normalize(os.tmpdir()))) {
        return NextResponse.json({ error: "Target path outside allowed root" }, { status: 403 });
      }

      if (!fs.existsSync(norm)) {
        return NextResponse.json({ error: "Target path does not exist" }, { status: 404 });
      }

      // Initialize git
      execFileSync("git", ["init", "-b", "main"], { cwd: norm, stdio: ["pipe", "pipe", "ignore"] });

      // Check if repo has any commits
      let hasCommits = false;
      try {
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: norm, stdio: ["pipe", "pipe", "ignore"] });
        hasCommits = true;
      } catch {}

      if (!hasCommits) {
        // Create initial README commit so repo has a valid base commit
        const readmePath = path.join(norm, "README.md");
        if (!fs.existsSync(readmePath)) {
          fs.writeFileSync(readmePath, `# ${path.basename(norm)}\n\nProject initialized.\n`, "utf8");
        }
        execFileSync("git", ["config", "user.name", "Local Agent"], { cwd: norm });
        execFileSync("git", ["config", "user.email", "agent@local-sandbox.internal"], { cwd: norm });
        execFileSync("git", ["add", "."], { cwd: norm });
        execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: norm });
      }

      const toolchain = detectToolchain(norm);
      return NextResponse.json({
        success: true,
        targetPath: norm,
        defaultBranch: "main",
        toolchain
      });
    }

    if (action === "create-greenfield") {
      const projectName = (name || "new-project").trim();
      const slug = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
      const projectsDir = path.join(allowedRoot, "projects");
      if (!fs.existsSync(projectsDir)) {
        fs.mkdirSync(projectsDir, { recursive: true });
      }

      const projectPath = path.join(projectsDir, slug);
      if (fs.existsSync(projectPath)) {
        return NextResponse.json({ error: `Project directory already exists: ${slug}` }, { status: 409 });
      }

      fs.mkdirSync(projectPath, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: projectPath, stdio: ["pipe", "pipe", "ignore"] });
      fs.writeFileSync(path.join(projectPath, "README.md"), `# ${projectName}\n\nProject initialized.\n`, "utf8");
      execFileSync("git", ["config", "user.name", "Local Agent"], { cwd: projectPath });
      execFileSync("git", ["config", "user.email", "agent@local-sandbox.internal"], { cwd: projectPath });
      execFileSync("git", ["add", "."], { cwd: projectPath });
      execFileSync("git", ["commit", "-m", "Initial project commit"], { cwd: projectPath });

      return NextResponse.json(
        {
          success: true,
          projectPath,
          name: projectName,
          defaultBranch: "main",
          toolchain: "node:22"
        },
        { status: 201 }
      );
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
