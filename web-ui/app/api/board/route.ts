import { NextResponse } from "next/server";
import { ThreadStore } from "@/lib/threads/threadStore";

export async function GET() {
  const store = new ThreadStore(process.env.THREADS_DIR);
  const threads = await store.listThreads();
  const items = threads.map((t: any) => ({
    id: t.id,
    title: t.title || "Untitled",
    status: t.status || "idle",
    updatedAt: t.updatedAt,
    messageCount: typeof t.messageCount === "number" ? t.messageCount : 0,
  }));
  return NextResponse.json({ items, total: items.length });
}
