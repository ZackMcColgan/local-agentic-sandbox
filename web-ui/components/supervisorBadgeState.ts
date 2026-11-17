import { MAX_AUTO_RESUMES } from "../lib/threads/inAppSupervisor";

export interface SupervisorBadgeInput {
  needsAttention?: boolean;
  stalledReason?: string;
  autoResumeCount?: number;
}

export type SupervisorBadgeState =
  | { kind: "needs_attention"; label: string; detail?: string }
  | { kind: "stalled"; label: string; detail?: string }
  | { kind: "auto_resumed"; label: string; detail?: string }
  | null;

export function deriveSupervisorBadgeState(input: SupervisorBadgeInput): SupervisorBadgeState {
  if (input.needsAttention) {
    return {
      kind: "needs_attention",
      label: "Needs attention",
      detail: input.stalledReason || "Supervisor stopped after max auto-resumes",
    };
  }
  if (input.stalledReason) {
    return {
      kind: "stalled",
      label: "Stalled",
      detail: input.stalledReason,
    };
  }
  if (input.autoResumeCount && input.autoResumeCount > 0) {
    return {
      kind: "auto_resumed",
      label: `Auto-resumed (${input.autoResumeCount}/${MAX_AUTO_RESUMES})`,
    };
  }
  return null;
}
