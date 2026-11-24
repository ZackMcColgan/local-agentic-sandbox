import { NextRequest, NextResponse } from "next/server";
import { getAgreementLedgerStore, isValidGateVerdict } from "@/lib/board/agreementLedger";
import {
  createProductionEvaluateDeps,
  evaluatePrShadowVerdict,
  type ReviewerEvaluateDeps,
} from "@/lib/board/reviewerAuditEvaluate";

export async function GET() {
  try {
    const ledger = getAgreementLedgerStore().read();
    return NextResponse.json({ ledger });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load reviewer agreement ledger";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: unknown;
      pr?: unknown;
      brief?: unknown;
      allowlist?: unknown;
      headSha?: unknown;
      driverVerdict?: unknown;
      reason?: unknown;
    };

    if (body?.action === "evaluate") {
      return await handleEvaluate(body);
    }

    if (typeof body?.pr !== "number" || !Number.isInteger(body.pr) || body.pr <= 0) {
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

    if (body.headSha !== undefined && (typeof body.headSha !== "string" || !body.headSha.trim())) {
      return NextResponse.json(
        { error: "Invalid headSha; expected a non-empty string when provided" },
        { status: 400 }
      );
    }

    const headSha = typeof body.headSha === "string" ? body.headSha.trim() : undefined;
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;

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
    const message = err instanceof Error ? err.message : "Failed to record reviewer audit verdict";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Stage 0 measurement: dispatch a fresh reviewer thread for ANY PR (including
 * operator-flowed PRs built outside the drain) and record the shadow verdict
 * in the agreement ledger. Grants NO merge authority; Stage 3 stays OFF.
 * The call returns once the verdict is recorded - the reviewer dispatch is
 * synchronous in-process (same shape as the drain's issueReviewerThread), so
 * no async thread-id handoff is needed.
 */
async function handleEvaluate(body: {
  pr?: unknown;
  brief?: unknown;
  allowlist?: unknown;
}): Promise<NextResponse> {
  if (typeof body.pr !== "number" || !Number.isInteger(body.pr) || body.pr <= 0) {
    return NextResponse.json(
      { error: "Invalid pr; expected a positive integer PR number" },
      { status: 400 }
    );
  }

  if (typeof body.brief !== "string" || !body.brief.trim()) {
    return NextResponse.json(
      { error: "Invalid brief; expected a non-empty string describing the PR under review" },
      { status: 400 }
    );
  }

  const allowlist = Array.isArray(body.allowlist)
    ? body.allowlist.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
      )
    : [];

  const mock = (globalThis as { __mockReviewerEvaluateDeps?: ReviewerEvaluateDeps | null })
    .__mockReviewerEvaluateDeps;
  const deps = mock ?? createProductionEvaluateDeps();

  try {
    const result = await evaluatePrShadowVerdict(deps, {
      prNumber: body.pr,
      brief: body.brief.trim(),
      allowlist,
    });
    return NextResponse.json({
      entry: result.entry,
      verdict: result.verdict,
      mechanicalVerdict: result.mechanicalVerdict,
      reviewerVerdict: result.reviewerVerdict,
      threadId: result.threadId,
      headSha: result.headSha,
      headShaResolved: result.headShaResolved,
      mergeAuthorized: result.mergeAuthorized,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reviewer evaluation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
