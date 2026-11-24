import { NextResponse } from "next/server";
import {
  loadOperatorMemory,
  saveOperatorMemory,
  OPERATOR_MEMORY_MAX_CHARS,
} from "@/lib/memory/operatorMemory";
import { parseJsonBody } from "@/lib/apiJson";

export async function GET() {
  try {
    const memory = loadOperatorMemory();
    return NextResponse.json({ text: memory.text, updatedAt: memory.updatedAt });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (typeof body.text !== "string") {
      return NextResponse.json({ error: "Invalid payload: text string required" }, { status: 400 });
    }
    if (body.text.length > OPERATOR_MEMORY_MAX_CHARS) {
      return NextResponse.json(
        {
          error: `Memory text exceeds the ${OPERATOR_MEMORY_MAX_CHARS}-character cap (${body.text.length} characters). Shorten it before saving.`,
        },
        { status: 400 }
      );
    }
    const saved = saveOperatorMemory(body.text);
    return NextResponse.json({
      success: true,
      text: saved.text,
      updatedAt: saved.updatedAt,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
