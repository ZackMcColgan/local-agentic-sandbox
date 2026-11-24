import { NextRequest, NextResponse } from "next/server";
import {
  fileBoardItem,
  getBoardStore,
  isValidBoardStatus,
  seedBoardIfEmpty,
  type CreateBoardItemInput,
  type UpdateBoardItemInput,
} from "@/lib/board/boardStore";
import { mergeThreadsIntoBoard } from "@/lib/board/mergeThreadsIntoBoard";

export async function GET() {
  try {
    const store = getBoardStore();
    const items = await mergeThreadsIntoBoard(seedBoardIfEmpty(store));
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load board";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<CreateBoardItemInput>;
    const created = fileBoardItem({
      key: body.key,
      title: body.title ?? "",
      brief: body.brief ?? "",
      dependencies: body.dependencies ?? [],
      author: (body.author as "Owner") ?? "Owner",
      source: body.source ?? "manual",
      threadLink: body.threadLink,
      sprint: body.sprint,
    });
    return NextResponse.json({ item: created }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create board item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { id?: string } & UpdateBoardItemInput;
    if (!body.id) {
      return NextResponse.json({ error: "Missing item id" }, { status: 400 });
    }
    if (body.status !== undefined && !isValidBoardStatus(body.status)) {
      return NextResponse.json(
        { error: `Invalid board status: ${String(body.status)}` },
        { status: 400 }
      );
    }
    const { id, ...patch } = body;
    const updated = getBoardStore().update(id, patch);
    return NextResponse.json({ item: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update board item";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    let id = req.nextUrl.searchParams.get("id");
    if (!id) {
      const body = (await req.json().catch(() => null)) as { id?: string } | null;
      id = body?.id ?? null;
    }
    if (!id || typeof id !== "string" || !id.trim()) {
      return NextResponse.json({ error: "Missing item id" }, { status: 400 });
    }
    const removed = getBoardStore().remove(id.trim());
    return NextResponse.json({ success: true, removed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete board item";
    const status = message.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
