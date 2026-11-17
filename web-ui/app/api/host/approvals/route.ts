import { NextResponse } from "next/server";
import {
  getPendingApprovals,
  consumePendingApproval,
  recordContinuationEntry,
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
    const approvalId = body.approvalId;
    const action = body.action || body.decision;

    if (!approvalId || (action !== "approved" && action !== "rejected")) {
      return NextResponse.json({ error: "Invalid approval action" }, { status: 400 });
    }

    const consumption = consumePendingApproval(approvalId, action);

    if (consumption.status === "not_found") {
      return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
    }

    if (consumption.status === "conflict") {
      return NextResponse.json({ error: "Approval request already consumed" }, { status: 409 });
    }

    if (consumption.status === "expired") {
      const approval = consumption.approval;
      recordContinuationEntry({
        approvalId: approval.id,
        threadId: approval.threadId,
        tool: approval.tool,
        args: approval.args,
        status: "expired"
      });
      return NextResponse.json({ error: "Approval request expired", status: "expired" }, { status: 410 });
    }

    const approval = consumption.approval;

    if (action === "rejected") {
      recordContinuationEntry({
        approvalId: approval.id,
        threadId: approval.threadId,
        tool: approval.tool,
        args: approval.args,
        status: "rejected"
      });
      return NextResponse.json({ success: true, status: "rejected", approvalId: approval.id });
    }

    // action === "approved"
    try {
      const result = await executeHostTool(approval.tool, approval.args, approval.id);

      if (result && result.success === false) {
        recordContinuationEntry({
          approvalId: approval.id,
          threadId: approval.threadId,
          tool: approval.tool,
          args: approval.args,
          status: "error",
          error: result.error || "Host tool execution reported failure",
          result
        });
        return NextResponse.json({ success: false, status: "error", approvalId: approval.id, result });
      }

      recordContinuationEntry({
        approvalId: approval.id,
        threadId: approval.threadId,
        tool: approval.tool,
        args: approval.args,
        status: "executed",
        result
      });
      return NextResponse.json({ success: true, status: "executed", approvalId: approval.id, result });
    } catch (execErr: any) {
      recordContinuationEntry({
        approvalId: approval.id,
        threadId: approval.threadId,
        tool: approval.tool,
        args: approval.args,
        status: "error",
        error: execErr?.message || "Host tool execution threw an exception"
      });
      return NextResponse.json({ success: false, error: execErr?.message || "Execution error" }, { status: 500 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });
  }
}
