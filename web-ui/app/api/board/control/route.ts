import { NextRequest, NextResponse } from "next/server";
import { getBoardControlStore, isValidBoardControlAction } from "@/lib/board/boardControlStore";

export async function GET() {
  try {
    const control = getBoardControlStore().getState();
    return NextResponse.json({ control });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load board control state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: unknown;
      drainBudget?: unknown;
      threadId?: unknown;
      taskId?: unknown;
    };

    if (!isValidBoardControlAction(body?.action)) {
      return NextResponse.json(
        { error: "Invalid action; expected 'start' | 'pause' | 'stop'" },
        { status: 400 }
      );
    }

    let drainBudget: number | null | undefined = undefined;
    if (body.drainBudget !== undefined) {
      if (body.drainBudget === null) {
        drainBudget = null;
      } else if (
        typeof body.drainBudget === "number" &&
        Number.isInteger(body.drainBudget) &&
        body.drainBudget >= 1
      ) {
        drainBudget = body.drainBudget;
      } else {
        return NextResponse.json(
          { error: "Invalid drainBudget; expected positive integer or null" },
          { status: 400 }
        );
      }
    }

    const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    const taskId = typeof body.taskId === "string" ? body.taskId : undefined;

    const result = await getBoardControlStore().applyAction(body.action, {
      drainBudget,
      threadId,
      taskId,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update board control state";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
