import { NextRequest, NextResponse } from "next/server";
import {
  previewMonsterIntake,
  confirmMonsterIntake,
  IntakeValidationError,
  IntakeModelError,
  type IntakeStackItem,
} from "@/lib/board/monsterIntake";
import { ModelUnavailableError } from "@/lib/subagents/llmClient";

interface IntakeRouteBody {
  action?: "preview" | "confirm";
  prompt?: string;
  repoMapSummary?: string;
  model?: string;
  items?: IntakeStackItem[];
  startDrain?: boolean;
}

/**
 * POST /api/board/intake
 *
 * Action shape:
 * - Preview: `{ action: "preview", prompt: string, repoMapSummary?: string, model?: string }`
 *   Runs ONE bounded P2_ORCHESTRATOR model call and returns `{ items, model }`.
 *   Performs ZERO writes to the board store.
 * - Confirm: `{ action: "confirm", items: IntakeStackItem[], startDrain?: boolean }`
 *   Validates and atomically files all N items to Queued (and optionally sets
 *   ITEM-6 board control state to `running` when `startDrain: true`).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IntakeRouteBody;

    if (body.action === "preview") {
      const result = await previewMonsterIntake({
        prompt: body.prompt ?? "",
        repoMapSummary: body.repoMapSummary,
        model: body.model,
      });
      return NextResponse.json(result, { status: 200 });
    }

    if (body.action === "confirm") {
      const result = await confirmMonsterIntake({
        items: body.items ?? [],
        startDrain: Boolean(body.startDrain),
      });
      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json(
      { error: 'Invalid action: expected "preview" or "confirm"' },
      { status: 400 }
    );
  } catch (err) {
    if (err instanceof IntakeValidationError) {
      return NextResponse.json(
        { error: err.message, reasons: err.reasons },
        { status: err.statusCode }
      );
    }
    if (err instanceof IntakeModelError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Board intake failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
