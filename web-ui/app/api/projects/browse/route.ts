import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  confinePathToRoot,
  isStrictlyInsideRoot,
  resolveRealConfinedPath,
} from "@/lib/securityHardening";
import { parseJsonBody } from "@/lib/apiJson";

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
    if (
      fs.existsSync(path.join(dirPath, "pyproject.toml")) ||
      fs.existsSync(path.join(dirPath, "requirements.txt"))
    ) {
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
      stdio: ["pipe", "pipe", "ignore"],
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

    if (subpath.includes("\0")) {
      return NextResponse.json({ error: "Invalid subpath" }, { status: 400 });
    }

    const candidate = subpath ? path.resolve(allowedRoot, subpath) : allowedRoot;
    if (!isStrictlyInsideRoot(allowedRoot, candidate)) {
      return NextResponse.json({ error: "Access forbidden: directory traversal" }, { status: 403 });
    }

    const confined = resolveRealConfinedPath(allowedRoot, candidate);
    if (!confined.ok) {
      if (confined.reason === "not_found") {
        return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
      }
      return NextResponse.json({ error: "Access forbidden: directory traversal" }, { status: 403 });
    }

    const rootNorm = confined.canonicalRoot;
    const candidateNorm = confined.canonicalTarget;

    const stat = fs.statSync(candidateNorm);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const entries = fs.readdirSync(candidateNorm, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".agent") continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build")
        continue;

      if (entry.isDirectory()) {
        const full = path.join(candidateNorm, entry.name);
        if (!resolveRealConfinedPath(rootNorm, full).ok) continue;
        const isGitRepo = fs.existsSync(path.join(full, ".git"));
        const defaultBranch = isGitRepo ? detectDefaultBranch(full) : "main";
        const toolchain = detectToolchain(full);

        items.push({
          name: entry.name,
          path: full,
          relPath: path.relative(rootNorm, full).replace(/\\/g, "/"),
          isGitRepo,
          defaultBranch,
          toolchain,
        });
      }
    }

    // Sort: git repos first, then alphabetical
    items.sort((a, b) => {
      if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const isAtRoot = path.relative(rootNorm, candidateNorm) === "";
    const parentPath = isAtRoot ? null : path.dirname(candidateNorm);

    return NextResponse.json({
      allowedRoot: rootNorm,
      currentPath: candidateNorm,
      relPath: path.relative(rootNorm, candidateNorm).replace(/\\/g, "/") || ".",
      isAtRoot,
      parentPath,
      items,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const allowedRoot = getAllowedRoot();
    const { action, targetPath, name } = body;

    if (action === "init-repo") {
      if (!targetPath || typeof targetPath !== "string" || targetPath.includes("\0")) {
        return NextResponse.json({ error: "Missing or invalid targetPath" }, { status: 400 });
      }

      const resolvedTarget = path.resolve(targetPath);
      const allowedBases = [allowedRoot, os.tmpdir()];
      if (!allowedBases.some((base) => isStrictlyInsideRoot(base, resolvedTarget))) {
        return NextResponse.json({ error: "Target path outside allowed root" }, { status: 403 });
      }

      let norm: string | null = null;
      let sawNotFound = false;
      for (const base of allowedBases) {
        const confined = resolveRealConfinedPath(base, resolvedTarget);
        if (confined.ok) {
          norm = confined.canonicalTarget;
          break;
        }
        if (confined.reason === "not_found") {
          sawNotFound = true;
        }
      }

      if (!norm) {
        return NextResponse.json(
          {
            error: sawNotFound ? "Target path does not exist" : "Target path outside allowed root",
          },
          { status: sawNotFound ? 404 : 403 }
        );
      }

      // Initialize git
      execFileSync("git", ["init", "-b", "main"], { cwd: norm, stdio: ["pipe", "pipe", "ignore"] });

      // Check if repo has any commits
      let hasCommits = false;
      try {
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: norm,
          stdio: ["pipe", "pipe", "ignore"],
        });
        hasCommits = true;
      } catch {}

      if (!hasCommits) {
        // Create initial README commit so repo has a valid base commit
        const readmePath = path.join(norm, "README.md");
        if (!fs.existsSync(readmePath)) {
          fs.writeFileSync(
            readmePath,
            `# ${path.basename(norm)}\n\nProject initialized.\n`,
            "utf8"
          );
        }
        execFileSync("git", ["config", "user.name", "Local Agent"], { cwd: norm });
        execFileSync("git", ["config", "user.email", "agent@local-sandbox.internal"], {
          cwd: norm,
        });
        execFileSync("git", ["add", "."], { cwd: norm });
        execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: norm });
      }

      const toolchain = detectToolchain(norm);
      return NextResponse.json({
        success: true,
        targetPath: norm,
        defaultBranch: "main",
        toolchain,
      });
    }

    if (action === "create-greenfield") {
      const projectName = (name || "new-project").trim();
      const slug = projectName
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!slug || slug === "." || slug === "..") {
        return NextResponse.json({ error: "Invalid project name" }, { status: 400 });
      }
      const projectsDir = path.join(allowedRoot, "projects");
      if (!fs.existsSync(projectsDir)) {
        fs.mkdirSync(projectsDir, { recursive: true });
      }

      const projectPath = confinePathToRoot(projectsDir, slug);
      if (fs.existsSync(projectPath)) {
        return NextResponse.json(
          { error: `Project directory already exists: ${slug}` },
          { status: 409 }
        );
      }

      fs.mkdirSync(projectPath, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectPath,
        stdio: ["pipe", "pipe", "ignore"],
      });
      fs.writeFileSync(
        path.join(projectPath, "README.md"),
        `# ${projectName}\n\nProject initialized.\n`,
        "utf8"
      );
      execFileSync("git", ["config", "user.name", "Local Agent"], { cwd: projectPath });
      execFileSync("git", ["config", "user.email", "agent@local-sandbox.internal"], {
        cwd: projectPath,
      });
      execFileSync("git", ["add", "."], { cwd: projectPath });
      execFileSync("git", ["commit", "-m", "Initial project commit"], { cwd: projectPath });

      return NextResponse.json(
        {
          success: true,
          projectPath,
          name: projectName,
          defaultBranch: "main",
          toolchain: "node:22",
        },
        { status: 201 }
      );
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
