/**
 * Bounded parallel fan-out dispatcher for read-only tool calls within a chat round.
 *
 * Contiguous runs of known read-only tools execute concurrently up to TOOL_FANOUT_CAP
 * in-flight calls while preserving emission-order commit semantics and failure isolation.
 * Any non-read-only tool acts as a strict ordering barrier: preceding reads complete and
 * commit before the barrier runs alone, then fan-out resumes afterward.
 */

export const TOOL_FANOUT_CAP = 8;

/**
 * Explicit enumeration of registered read-only tools eligible for concurrent fan-out.
 *
 * - Host filesystem / git inspection: host_read_file, host_list_dir, host_git_status, host_git_pr_status
 * - Workspace / sandbox inspection: workspace_read_file, workspace_get_tree, workspace_grep,
 *   git_status, git_diff, verify_container_provenance, docker_scout_policy_gate
 * - Progressive disclosure metadata lookup: describe_tool
 *
 * Web research tools (search_web, fetch_webpage_markdown) intentionally remain barriers
 * because they update per-turn web-research budget / grounding-gate state and hit
 * rate-limited external endpoints.
 */
export const READ_ONLY_FANOUT_TOOLS: ReadonlySet<string> = new Set([
  "host_read_file",
  "host_list_dir",
  "host_git_status",
  "host_git_pr_status",
  "workspace_read_file",
  "workspace_get_tree",
  "workspace_grep",
  "git_status",
  "git_diff",
  "verify_container_provenance",
  "docker_scout_policy_gate",
  "describe_tool",
]);

export function isReadOnlyFanoutTool(toolName: string): boolean {
  return READ_ONLY_FANOUT_TOOLS.has(toolName);
}

export interface IndexedToolItem<T> {
  index: number;
  item: T;
}

export type ToolCallBatch<T> =
  { kind: "parallel"; items: IndexedToolItem<T>[] } | { kind: "barrier"; index: number; item: T };

/**
 * Partitions a round's emitted tool calls into maximal contiguous parallel batches
 * of read-only calls separated by single-item barrier steps, preserving exact emission order.
 */
export function partitionToolCallBatches<T>(
  calls: readonly T[],
  isParallelEligible: (call: T, index: number) => boolean
): ToolCallBatch<T>[] {
  const batches: ToolCallBatch<T>[] = [];
  let currentParallel: IndexedToolItem<T>[] = [];

  for (let i = 0; i < calls.length; i++) {
    const item = calls[i];
    if (isParallelEligible(item, i)) {
      currentParallel.push({ index: i, item });
    } else {
      if (currentParallel.length > 0) {
        batches.push({ kind: "parallel", items: currentParallel });
        currentParallel = [];
      }
      batches.push({ kind: "barrier", index: i, item });
    }
  }

  if (currentParallel.length > 0) {
    batches.push({ kind: "parallel", items: currentParallel });
  }

  return batches;
}

/**
 * Runs an async worker over `items` with at most `cap` executions in flight at once.
 * Output array strictly preserves input order regardless of completion order.
 */
export async function executeWithConcurrencyLimit<T, R>(
  items: readonly T[],
  cap: number,
  worker: (item: T, position: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Math.floor(cap) || 1, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: concurrency }, () => runWorker());
  await Promise.all(workers);
  return results;
}
