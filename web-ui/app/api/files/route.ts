import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".drawio":
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const requestedPath = url.searchParams.get("path");
    const asJson = url.searchParams.get("format") === "json" || url.searchParams.get("json") === "true";

    if (!requestedPath || typeof requestedPath !== "string") {
      return NextResponse.json({ error: "Missing required 'path' query parameter" }, { status: 400 });
    }

    // Clean leading slashes
    const cleanPath = requestedPath.replace(/^[\/\\]+/, "").trim();

    // Prevent path traversal
    if (cleanPath.includes("..")) {
      return NextResponse.json({ error: "Access forbidden: path traversal detected" }, { status: 403 });
    }

    // Determine candidate root directories where files might reside
    const cwd = process.cwd();
    const candidateRoots = [
      process.env.WORKSPACE_DIR || "/workspace",
      path.resolve(cwd, "..", "workspace"),
      path.resolve(cwd, "workspace"),
      fs.existsSync(path.join(cwd, "docs"))
        ? cwd
        : fs.existsSync(path.resolve(cwd, "..", "docs"))
        ? path.resolve(cwd, "..")
        : cwd
    ];

    // Check if target is a directory across candidate roots (directory listing is forbidden)
    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;
      const candidate = path.resolve(root, cleanPath);
      const rel = path.relative(root, candidate);
      if (!rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.isDirectory()) {
            return NextResponse.json({ error: "Access forbidden: directory listing not permitted" }, { status: 403 });
          }
        } catch {}
      }
    }

    // Strict content-type check: only SVG and Draw.io XML files permitted
    const ext = path.extname(cleanPath).toLowerCase();
    const isAllowedExt =
      ext === ".svg" ||
      ext === ".drawio" ||
      cleanPath.endsWith(".drawio.xml") ||
      ext === ".xml";

    if (!isAllowedExt) {
      return NextResponse.json(
        { error: "Unsupported media type: only SVG and Draw.io XML diagrams are permitted" },
        { status: 415 }
      );
    }

    let resolvedPath: string | null = null;

    // Check each candidate root
    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) continue;

      // Try with direct cleanPath
      const candidate1 = path.resolve(root, cleanPath);
      const rel1 = path.relative(root, candidate1);
      if (!rel1.startsWith("..") && !path.isAbsolute(rel1) && fs.existsSync(candidate1)) {
        try {
          const stat = fs.statSync(candidate1);
          if (stat.isDirectory()) {
            return NextResponse.json({ error: "Access forbidden: directory listing not permitted" }, { status: 403 });
          }
          if (stat.isFile()) {
            resolvedPath = candidate1;
            break;
          }
        } catch {}
      }

      // If cleanPath starts with "workspace/", strip it when searching inside workspace root
      if (cleanPath.startsWith("workspace/") || cleanPath.startsWith("workspace\\")) {
        const stripped = cleanPath.replace(/^workspace[\/\\]/, "");
        const candidate2 = path.resolve(root, stripped);
        const rel2 = path.relative(root, candidate2);
        if (!rel2.startsWith("..") && !path.isAbsolute(rel2) && fs.existsSync(candidate2)) {
          try {
            const stat = fs.statSync(candidate2);
            if (stat.isFile()) {
              resolvedPath = candidate2;
              break;
            }
          } catch {}
        }
      }
    }

    // If file not found locally on disk, try proxying to mcp-server if available
    if (!resolvedPath) {
      const mcpEnv = process.env.MCP_SERVER_URL || process.env.MCP_URL;
      const mcpBase = mcpEnv
        ? mcpEnv.replace(/\/sse\/?$/, "")
        : "http://localhost:8080";

      try {
        const mcpFileRes = await fetch(`${mcpBase}/files?path=${encodeURIComponent(cleanPath)}`, {
          signal: AbortSignal.timeout(3000)
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
              content: textContent
            });
          }
          return new NextResponse(Buffer.from(fileBuffer), {
            status: 200,
            headers: {
              "Content-Type": mimeType,
              "Content-Length": fileBuffer.byteLength.toString(),
              "Cache-Control": "public, max-age=60"
            }
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
        content
      });
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": stat.size.toString(),
        "Cache-Control": "public, max-age=60"
      }
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: "Internal server error reading file", details: error.message },
      { status: 500 }
    );
  }
}
