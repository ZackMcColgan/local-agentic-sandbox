import { NextResponse } from "next/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonObjectBody = Record<string, any>;

export type ParseJsonBodyResult<T = JsonObjectBody> =
  { ok: true; body: T } | { ok: false; response: NextResponse };

/**
 * Safely parses an HTTP request JSON object body, returning HTTP 400
 * `{ error: "Invalid JSON body" }` instead of letting SyntaxError bubble to 500.
 */
export async function parseJsonBody<T = JsonObjectBody>(req: {
  json: () => Promise<unknown>;
}): Promise<ParseJsonBodyResult<T>> {
  try {
    const parsed = await req.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
      };
    }
    return { ok: true, body: parsed as T };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}
