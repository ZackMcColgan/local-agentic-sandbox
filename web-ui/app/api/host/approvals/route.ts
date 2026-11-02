import { NextResponse } from "next/server";
import {
  getPendingApprovals,
  resolvePendingApproval,
  executeHostTool
} from "@/lib/hostMode";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const threadId = searchParams.get("threadId") || undefined;
    const approvals = getPendingApprovals(threadId);
    return NextResponse.json({ approvals });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { approvalId, action } = body;

    if (!approvalId || (action !== "approved" && action !== "rejected")) {
      return NextResponse.json({ error: "Invalid approval action" }, { status: 400 });
    }

    const resolved = resolvePendingApproval(approvalId, action);
    if (!resolved) {
      return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
    }

    if (action === "approved") {
      try {
        const result = await executeHostTool(resolved.tool, resolved.args);
        return NextResponse.json({ success: true, status: "executed", result });
      } catch (execErr: any) {
        return NextResponse.json({ success: false, error: execErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, status: "rejected" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
