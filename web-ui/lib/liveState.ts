export interface LiveStatusPayload {
  round: number;
  phase: "reasoning" | "tool_execution" | "synthesis" | "completed";
  activeTool?: string;
  tokensUsed?: number;
  updatedAt: string;
}

export function buildLiveStatus(input: Omit<LiveStatusPayload, "updatedAt">): LiveStatusPayload {
  return {
    ...input,
    updatedAt: new Date().toISOString(),
  };
}

export interface ExecutionSummary {
  rounds: number;
  toolsCalled: string[];
  filesModified: string[];
  status: "completed" | "incomplete" | "failed";
}

export function buildExecutionSummary(input: ExecutionSummary): ExecutionSummary {
  return {
    rounds: input.rounds,
    toolsCalled: Array.from(new Set(input.toolsCalled)),
    filesModified: Array.from(new Set(input.filesModified)),
    status: input.status,
  };
}

export function formatExecutionSummaryForMorningReport(summary: ExecutionSummary): string {
  const tools = summary.toolsCalled.length > 0 ? summary.toolsCalled.join(", ") : "none";
  const files = summary.filesModified.length > 0 ? summary.filesModified.join(", ") : "none";
  return `${summary.status} (${summary.rounds} rounds; tools: ${tools}; files: ${files})`;
}

export function seedReadDedupFromHistory(messages: Array<Record<string, any>>): Set<string> {
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (tc?.function?.name !== "workspace_read_file" && tc?.function?.name !== "read_file") continue;
      let args = tc.function.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (args?.path && typeof args.path === "string") {
        seen.add(args.path);
      }
    }
  }
  return seen;
}

function approxTokens(msg: Record<string, any>): number {
  return Math.ceil(JSON.stringify(msg).length / 4);
}

export function evictPairedToolCalls(
  messages: Array<Record<string, any>>,
  maxTokens: number
): Array<Record<string, any>> {
  const result = [...messages];
  let total = result.reduce((sum, m) => sum + approxTokens(m), 0);

  while (total > maxTokens) {
    const callIdx = result.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    if (callIdx === -1) break;

    const callIds = new Set<string>(
      result[callIdx].tool_calls.map((tc: any) => tc.id).filter(Boolean)
    );
    const toRemove = new Set<number>([callIdx]);
    for (let i = callIdx + 1; i < result.length; i++) {
      if (result[i].role === "tool" && callIds.has(result[i].tool_call_id)) {
        toRemove.add(i);
      }
    }

    const removed = result.filter((_, idx) => toRemove.has(idx));
    for (const m of removed) total -= approxTokens(m);
    const kept = result.filter((_, idx) => !toRemove.has(idx));
    result.length = 0;
    result.push(...kept);
  }

  return result;
}
