import { NextRequest, NextResponse } from "next/server";
import {
  loadPendingQueue,
  savePendingQueue,
  recordObservedPattern,
  approveSkillCandidate,
  rejectSkillCandidate,
  listActiveSkills,
  SkillCandidate
} from "@/lib/subagents/skillGate";
import { FlywheelSkillsStore } from "@/lib/flywheel/skillsStore";

export async function GET(_req: NextRequest) {
  let flywheelStore: FlywheelSkillsStore | null = null;
  try {
    const queue = loadPendingQueue();
    const allCandidates = Object.values(queue.candidates || {});
    const pendingCandidates = allCandidates.filter(
      (c: SkillCandidate) => c.status === "pending" && c.occurrences >= 3
    );
    const activeSkills = listActiveSkills();

    let flywheelSkills: any[] = [];
    try {
      flywheelStore = new FlywheelSkillsStore();
      flywheelSkills = flywheelStore.listSkills();
    } catch {}

    return NextResponse.json({
      pendingCount: pendingCandidates.length,
      pendingCandidates,
      allCandidates,
      activeSkills,
      flywheelSkills
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    if (flywheelStore) {
      try {
        flywheelStore.close();
      } catch {}
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action;
    const id = body.candidateId || body.slug || body.id;

    if (!action || !id) {
      return NextResponse.json(
        { error: "Missing required 'action' or candidate identifier ('candidateId', 'slug', or 'id')" },
        { status: 400 }
      );
    }

    if (action === "propose") {
      const title = body.title || body.name || id;
      const solutionSummary = body.solutionSummary || body.content || body.description || "";
      const res = recordObservedPattern(id, { title, solutionSummary }, { minOccurrences: 1 });
      if (res.candidate.occurrences < 3) {
        const store = loadPendingQueue();
        if (store.candidates[id]) {
          store.candidates[id].occurrences = 3;
          savePendingQueue(store);
          res.candidate.occurrences = 3;
        }
      }
      return NextResponse.json({
        proposed: true,
        candidateId: id,
        candidate: res.candidate,
        isPendingApproval: true
      });
    }

    if (action === "approve") {
      const result = approveSkillCandidate(id);
      if (!result.promoted) {
        return NextResponse.json({ error: result.error || "Approval failed" }, { status: 400 });
      }
      return NextResponse.json(result);
    }

    if (action === "reject") {
      const result = rejectSkillCandidate(id);
      if (!result.rejected) {
        return NextResponse.json({ error: result.error || "Rejection failed" }, { status: 400 });
      }
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
