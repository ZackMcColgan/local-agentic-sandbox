import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { resolveThreadsDir } from "@/lib/threads/threadStore";
import {
  confinePathToRoot,
  isStrictlyInsideRoot,
  resolveRealConfinedPath,
} from "@/lib/securityHardening";
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
    if (!rawTrimmed || rawTrimmed.includes("\0")) {
      return NextResponse.json({ error: "Invalid 'path' query parameter" }, { status: 400 });
    }

    const isAbsoluteHostPath =
      /^[a-zA-Z]:[\\/]/.test(rawTrimmed) ||
      rawTrimmed.startsWith("/") ||
      rawTrimmed.startsWith("\\\\");
    // Clean leading slashes for relative workspace lookups
    const cleanPath = isAbsoluteHostPath ? rawTrimmed : rawTrimmed.replace(/^[\/\\]+/, "").trim();

    // Prevent path traversal
    if (cleanPath.split(/[\\/]+/).includes("..")) {
      return NextResponse.json(
        { error: "Access forbidden: path traversal detected" },
        { status: 403 }
      );
    }

    // Determine candidate root directories where files might reside (never cwd or "..")
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
        hostCheckoutRoot,
        ...allowlistedProjectRoots,
      ])
    );

    const buildCandidatesForRoot = (root: string): string[] => {
      if (isAbsoluteHostPath) {
        const resolvedAbs = path.resolve(cleanPath);
        return isStrictlyInsideRoot(root, resolvedAbs) ? [resolvedAbs] : [];
      }
      const list: string[] = [];
      try {
        list.push(confinePathToRoot(root, cleanPath));
      } catch {
        return list;
      }
      if (cleanPath.startsWith("workspace/") || cleanPath.startsWith("workspace\\")) {
        const stripped = cleanPath.replace(/^workspace[\/\\]/, "");
        try {
          list.push(confinePathToRoot(root, stripped));
        } catch {}
      }
      if (
        root === threadsDir &&
        (cleanPath.startsWith(".agent/threads/") || cleanPath.startsWith(".agent\\threads\\"))
      ) {
        const stripped = cleanPath.replace(/^\.agent[\/\\]threads[\/\\]/, "");
        try {
          list.push(confinePathToRoot(root, stripped));
        } catch {}
      }
      return list;
    };

    // Enforce confinement, resolve symlinks, forbid directories, and locate target file
    let matchedAnyRoot = false;
    let resolvedPath: string | null = null;
    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;
      const candidatesToCheck = buildCandidatesForRoot(root);
      if (candidatesToCheck.length > 0) {
        matchedAnyRoot = true;
      }
      for (const candidate of candidatesToCheck) {
        const confined = resolveRealConfinedPath(root, candidate);
        if (!confined.ok) {
          if (confined.reason === "symlink_escape" || confined.reason === "outside_root") {
            return NextResponse.json(
              { error: "Access denied: path escapes root" },
              { status: 403 }
            );
          }
          continue;
        }
        try {
          const stat = fs.statSync(confined.canonicalTarget);
          if (stat.isDirectory()) {
            return NextResponse.json(
              { error: "Access forbidden: directory listing not permitted" },
              { status: 403 }
            );
          }
          if (!resolvedPath && stat.isFile()) {
            resolvedPath = confined.canonicalTarget;
          }
        } catch {}
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

    // If file not found locally on disk, try proxying to mcp-server if available
    if (!resolvedPath) {
      if (!isAbsoluteHostPath) {
        const mcpEnv = process.env.MCP_SERVER_URL || process.env.MCP_URL;
        const mcpBase = mcpEnv ? mcpEnv.replace(/\/(mcp|sse)\/?$/, "") : "http://localhost:8080";

        try {
          const mcpSecret = process.env.MCP_SHARED_SECRET?.trim();
          const mcpFileRes = await fetch(`${mcpBase}/files?path=${encodeURIComponent(cleanPath)}`, {
            headers: mcpSecret ? { "x-mcp-shared-secret": mcpSecret } : undefined,
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
