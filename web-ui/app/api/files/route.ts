import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".json":
      return "application/json";
    case ".md":
    case ".txt":
      return "text/plain; charset=utf-8";
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

    const repoRoot = fs.existsSync(path.join(process.cwd(), "docs"))
      ? process.cwd()
      : fs.existsSync(path.resolve(process.cwd(), "..", "docs"))
      ? path.resolve(process.cwd(), "..")
      : process.cwd();

    const resolvedPath = path.resolve(repoRoot, requestedPath);
    const relative = path.relative(repoRoot, resolvedPath);

    // Strict path-traversal prevention: resolved file MUST be inside repoRoot
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return NextResponse.json({ error: "Access forbidden: path traversal detected" }, { status: 403 });
    }

    if (!fs.existsSync(resolvedPath)) {
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
        path: requestedPath,
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
