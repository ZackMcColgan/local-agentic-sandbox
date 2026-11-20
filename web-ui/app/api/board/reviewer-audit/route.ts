import { NextRequest, NextResponse } from "next/server";
import {
  getAgreementLedgerStore,
  isValidGateVerdict,
} from "@/lib/board/agreementLedger";

export async function GET() {
  try {
    const ledger = getAgreementLedgerStore().read();
    return NextResponse.json({ ledger });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load reviewer agreement ledger";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      pr?: unknown;
      headSha?: unknown;
      driverVerdict?: unknown;
      reason?: unknown;
    };

    if (
      typeof body?.pr !== "number" ||
      !Number.isInteger(body.pr) ||
      body.pr <= 0
    ) {
      return NextResponse.json(
        { error: "Invalid pr; expected a positive integer PR number" },
        { status: 400 }
      );
    }

    if (!isValidGateVerdict(body.driverVerdict)) {
      return NextResponse.json(
        { error: "Invalid driverVerdict; expected 'PASS' | 'FAIL'" },
        { status: 400 }
      );
    }

    if (
      body.headSha !== undefined &&
      (typeof body.headSha !== "string" || !body.headSha.trim())
    ) {
      return NextResponse.json(
        { error: "Invalid headSha; expected a non-empty string when provided" },
        { status: 400 }
      );
    }

    const headSha =
      typeof body.headSha === "string" ? body.headSha.trim() : undefined;
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : undefined;

    const ledger = getAgreementLedgerStore().recordDriverVerdict({
      prNumber: body.pr,
      headSha,
      driverVerdict: body.driverVerdict,
      reason,
    });

    if (!ledger) {
      return NextResponse.json(
        { error: `No shadow reviewer entry found for PR #${body.pr}` },
        { status: 404 }
      );
    }

    return NextResponse.json({ ledger });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to record reviewer audit verdict";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
