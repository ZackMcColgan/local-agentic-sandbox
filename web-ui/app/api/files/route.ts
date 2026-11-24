import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { resolveThreadsDir } from "@/lib/threads/threadStore";
import { confinePathToRoot } from "@/lib/securityHardening";
import { resolveHostCheckoutRoot } from "@/lib/explorer/explorerFs";

function resolveAllowlistedProjectRoots(): string[] {
  try {
    // Lazy-require so unit tests without native SQLite bindings stay green
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listProjects } = require("@/lib/projects/projectStore") as {
      listProjects: () => Array<{ root_path: string; allowlisted: number }>;
    };
    return listProjects()
      .filter((p) => p && p.allowlisted === 1 && typeof p.root_path === "string" && p.root_path)
      .map((p) => path.resolve(p.root_path));
  } catch {
    return [];
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".drawio":
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
    case ".log":
    case ".py":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".sh":
    case ".yaml":
    case ".yml":
    case ".sql":
    case ".css":
    case ".toml":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const ALLOWED_FILE_EXTENSIONS = new Set([
  ".svg",
  ".drawio",
  ".xml",
  ".md",
  ".txt",
  ".json",
  ".html",
  ".csv",
  ".log",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".yaml",
  ".yml",
  ".sql",
  ".css",
  ".toml",
]);

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const requestedPath = url.searchParams.get("path");
    const asJson =
      url.searchParams.get("format") === "json" || url.searchParams.get("json") === "true";
    const isDownload =
      url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";

    if (!requestedPath || typeof requestedPath !== "string") {
      return NextResponse.json(
        { error: "Missing required 'path' query parameter" },
        { status: 400 }
      );
    }

    const rawTrimmed = requestedPath.trim();
    const isAbsoluteHostPath =
      /^[a-zA-Z]:[\\/]/.test(rawTrimmed) ||
      (process.platform !== "win32" && rawTrimmed.startsWith("/"));
    // Clean leading slashes for relative workspace lookups
    const cleanPath = isAbsoluteHostPath ? rawTrimmed : rawTrimmed.replace(/^[\/\\]+/, "").trim();

    // Prevent path traversal
    if (cleanPath.split(/[\\/]+/).includes("..")) {
      return NextResponse.json(
        { error: "Access forbidden: path traversal detected" },
        { status: 403 }
      );
    }

    // Determine candidate root directories where files might reside
    const cwd = process.cwd();
    const threadsDir = resolveThreadsDir();
    const hostCheckoutRoot = resolveHostCheckoutRoot();
    const allowlistedProjectRoots = resolveAllowlistedProjectRoots();
    const candidateRoots = Array.from(
      new Set([
        threadsDir,
        process.env.WORKSPACE_DIR || "/workspace",
        path.resolve(cwd, "..", "workspace"),
        path.resolve(cwd, "workspace"),
        cwd,
        path.resolve(cwd, ".."),
        hostCheckoutRoot,
        ...allowlistedProjectRoots,
      ])
    );

    const isInsideRoot = (root: string, candidate: string): boolean => {
      const resolvedRoot = path.resolve(root);
      const resolvedCandidate = path.resolve(candidate);
      const rel = path.relative(resolvedRoot, resolvedCandidate);
      return !rel.startsWith("..") && !path.isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel);
    };

    // Check if target is a directory across candidate roots (directory listing is forbidden)
    let matchedAnyRoot = false;
    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;
      const candidatesToCheck: string[] = [];
      if (isAbsoluteHostPath) {
        const resolvedAbs = path.resolve(cleanPath);
        if (isInsideRoot(root, resolvedAbs)) {
          matchedAnyRoot = true;
          candidatesToCheck.push(resolvedAbs);
        }
      } else {
        try {
          candidatesToCheck.push(confinePathToRoot(root, cleanPath));
          matchedAnyRoot = true;
        } catch {
          continue;
        }
        if (cleanPath.startsWith("workspace/") || cleanPath.startsWith("workspace\\")) {
          candidatesToCheck.push(path.resolve(root, cleanPath.replace(/^workspace[\/\\]/, "")));
        }
        if (
          root === threadsDir &&
          (cleanPath.startsWith(".agent/threads/") || cleanPath.startsWith(".agent\\threads\\"))
        ) {
          candidatesToCheck.push(
            path.resolve(root, cleanPath.replace(/^\.agent[\/\\]threads[\/\\]/, ""))
          );
        }
      }
      for (const candidate of candidatesToCheck) {
        if (isInsideRoot(root, candidate) && fs.existsSync(candidate)) {
          try {
            const stat = fs.statSync(candidate);
            if (stat.isDirectory()) {
              return NextResponse.json(
                { error: "Access forbidden: directory listing not permitted" },
                { status: 403 }
              );
            }
          } catch {}
        }
      }
    }

    if (isAbsoluteHostPath && !matchedAnyRoot) {
      return NextResponse.json({ error: "Access denied: path escapes root" }, { status: 403 });
    }

    // Strict content-type check: text, diagram, and code artifacts permitted
    const ext = path.extname(cleanPath).toLowerCase();
    const isAllowedExt = ALLOWED_FILE_EXTENSIONS.has(ext) || cleanPath.endsWith(".drawio.xml");

    if (!isAllowedExt) {
      return NextResponse.json(
        {
          error:
            "Unsupported media type: only allowed text, diagram, and code artifacts are permitted",
        },
        { status: 415 }
      );
    }

    let resolvedPath: string | null = null;

    // Check each candidate root
    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;

      // Try with direct cleanPath (absolute inside root, or relative under root)
      const candidate1 = isAbsoluteHostPath
        ? path.resolve(cleanPath)
        : path.resolve(root, cleanPath);
      if (isInsideRoot(root, candidate1) && fs.existsSync(candidate1)) {
        try {
          const stat = fs.statSync(candidate1);
          if (stat.isDirectory()) {
            return NextResponse.json(
              { error: "Access forbidden: directory listing not permitted" },
              { status: 403 }
            );
          }
          if (stat.isFile()) {
            resolvedPath = candidate1;
            break;
          }
        } catch {}
      }

      if (isAbsoluteHostPath) continue;

      // If cleanPath starts with "workspace/", strip it when searching inside workspace root
      if (cleanPath.startsWith("workspace/") || cleanPath.startsWith("workspace\\")) {
        const stripped = cleanPath.replace(/^workspace[\/\\]/, "");
        const candidate2 = path.resolve(root, stripped);
        if (isInsideRoot(root, candidate2) && fs.existsSync(candidate2)) {
          try {
            const stat = fs.statSync(candidate2);
            if (stat.isFile()) {
              resolvedPath = candidate2;
              break;
            }
          } catch {}
        }
      }

      // If resolving against resolveThreadsDir() and cleanPath starts with ".agent/threads/", strip it
      if (
        root === threadsDir &&
        (cleanPath.startsWith(".agent/threads/") || cleanPath.startsWith(".agent\\threads\\"))
      ) {
        const stripped = cleanPath.replace(/^\.agent[\/\\]threads[\/\\]/, "");
        const candidate3 = path.resolve(root, stripped);
        if (isInsideRoot(root, candidate3) && fs.existsSync(candidate3)) {
          try {
            const stat = fs.statSync(candidate3);
            if (stat.isFile()) {
              resolvedPath = candidate3;
              break;
            }
          } catch {}
        }
      }
    }

    // If file not found locally on disk, try proxying to mcp-server if available
    if (!resolvedPath) {
      const mcpEnv = process.env.MCP_SERVER_URL || process.env.MCP_URL;
      const mcpBase = mcpEnv ? mcpEnv.replace(/\/(mcp|sse)\/?$/, "") : "http://localhost:8080";

      try {
        const mcpFileRes = await fetch(`${mcpBase}/files?path=${encodeURIComponent(cleanPath)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (mcpFileRes.ok) {
          const fileBuffer = await mcpFileRes.arrayBuffer();
          const mimeType = getMimeType(cleanPath);
          if (asJson) {
            const textContent = new TextDecoder().decode(fileBuffer);
            return NextResponse.json({
              path: cleanPath,
              size: fileBuffer.byteLength,
              mimeType,
              content: textContent,
            });
          }
          const headers: Record<string, string> = {
            "Content-Type": mimeType,
            "Content-Length": fileBuffer.byteLength.toString(),
            "Cache-Control": "public, max-age=60",
          };
          if (isDownload) {
            const basename = path.basename(cleanPath);
            const asciiName = basename.replace(/[^\x20-\x7E]/g, "_");
            const utf8Name = encodeURIComponent(basename);
            headers["Content-Disposition"] =
              `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
          }
          return new NextResponse(Buffer.from(fileBuffer), {
            status: 200,
            headers,
          });
        }
      } catch {
        // Fallback network attempt failed, proceed to 404
      }

      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Target is not a file" }, { status: 400 });
    }

    const mimeType = getMimeType(resolvedPath);

    if (asJson) {
      const content = fs.readFileSync(resolvedPath, "utf8");
      return NextResponse.json({
        path: cleanPath,
        size: stat.size,
        mimeType,
        content,
      });
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": stat.size.toString(),
      "Cache-Control": "public, max-age=60",
    };
    if (isDownload) {
      const basename = path.basename(resolvedPath);
      const asciiName = basename.replace(/[^\x20-\x7E]/g, "_");
      const utf8Name = encodeURIComponent(basename);
      headers["Content-Disposition"] =
        `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
    }
    return new NextResponse(fileBuffer, {
      status: 200,
      headers,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: "Internal server error reading file",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
