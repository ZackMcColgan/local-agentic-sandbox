import { NextRequest, NextResponse } from "next/server";
import {
  ExplorerAccessError,
  readExplorerFile,
  resolveHostCheckoutRoot,
} from "@/lib/explorer/explorerFs";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const relPath = url.searchParams.get("path") ?? "";
    const root = resolveHostCheckoutRoot();
    const file = readExplorerFile(root, relPath);
    return NextResponse.json(file);
  } catch (err) {
    if (err instanceof ExplorerAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }
}
