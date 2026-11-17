import { NextRequest, NextResponse } from "next/server";
import {
  ExplorerAccessError,
  listExplorerTree,
  resolveHostCheckoutRoot,
} from "@/lib/explorer/explorerFs";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const relPath = url.searchParams.get("path") ?? "";
    const root = resolveHostCheckoutRoot();
    const tree = listExplorerTree(root, relPath);
    return NextResponse.json({ rootName: tree.name, tree });
  } catch (err) {
    if (err instanceof ExplorerAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to list repository tree" }, { status: 500 });
  }
}
