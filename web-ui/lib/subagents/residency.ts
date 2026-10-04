/**
 * VRAM model-residency policy for the worker roster.
 *
 * Documented in docs/MODEL_RESIDENCY.md. Summary:
 *  - Each roster role has a call-frequency weight per task (builder/critic run every
 *    iteration, explorer/recorder once per milestone, planner once per task).
 *  - Distinct models are ranked by summed role weight and greedily PINNED while their
 *    combined size fits in (VRAM budget - headroom). Pinned models get a long keep_alive
 *    so they stay resident between planner -> builder -> critic steps (no reload thrash).
 *  - Models that do not fit are TRANSIENT: keep_alive 0, i.e. unloaded right after the
 *    call so they never push a pinned model out.
 *  - Eviction order when memory is needed: transient first (immediately), then
 *    non-roster models (e.g. the chat model) before any pinned roster model, then pinned
 *    models in reverse priority order.
 *  - Requesting a non-resident model: if it is pinned it is loaded and kept; if it is
 *    transient it is loaded for that single call and released.
 */

export type RosterMap = Record<string, string | undefined>;

export const ROLE_WEIGHTS: Record<string, number> = {
  builder: 10,
  critic: 10,
  explorer: 3,
  recorder: 3,
  planner: 1
};

export interface ResidencyPlanInput {
  roster: RosterMap;
  /** Model name -> approximate resident size in bytes. */
  modelSizes: Record<string, number>;
  vramBudgetBytes: number;
  /** Reserved for KV cache / context buffers. Default 10% of budget. */
  headroomBytes?: number;
}

export interface ResidencyPlan {
  pinned: string[];
  transient: string[];
  /** Priority order, highest first. Eviction goes in reverse. */
  priority: string[];
  usableBytes: number;
  pinnedBytes: number;
  unknownSize: string[];
}

export const PINNED_KEEP_ALIVE = "30m";
export const TRANSIENT_KEEP_ALIVE = 0;

export function planResidency(input: ResidencyPlanInput): ResidencyPlan {
  const headroom = input.headroomBytes ?? Math.round(input.vramBudgetBytes * 0.1);
  const usableBytes = Math.max(0, input.vramBudgetBytes - headroom);

  const weights = new Map<string, number>();
  for (const [role, model] of Object.entries(input.roster)) {
    if (!model) continue;
    weights.set(model, (weights.get(model) || 0) + (ROLE_WEIGHTS[role] ?? 1));
  }

  const priority = Array.from(weights.entries())
    .sort((a, b) => b[1] - a[1] || (input.modelSizes[a[0]] ?? Infinity) - (input.modelSizes[b[0]] ?? Infinity))
    .map(([model]) => model);

  const pinned: string[] = [];
  const transient: string[] = [];
  const unknownSize: string[] = [];
  let pinnedBytes = 0;

  for (const model of priority) {
    const size = input.modelSizes[model];
    if (size === undefined) {
      // Unknown size: never pin blindly — treat as transient so it cannot evict pinned models.
      unknownSize.push(model);
      transient.push(model);
      continue;
    }
    if (pinnedBytes + size <= usableBytes) {
      pinned.push(model);
      pinnedBytes += size;
    } else {
      transient.push(model);
    }
  }

  return { pinned, transient, priority, usableBytes, pinnedBytes, unknownSize };
}

export function keepAliveFor(plan: ResidencyPlan, model: string): string | number {
  return plan.pinned.includes(model) ? PINNED_KEEP_ALIVE : TRANSIENT_KEEP_ALIVE;
}

/**
 * Given what is currently loaded, returns models to unload (in order) so `incoming` can load
 * without evicting a pinned roster model. Transient and non-roster models go first.
 */
export function evictionOrder(plan: ResidencyPlan, loaded: string[], incoming: string): string[] {
  const others = loaded.filter((m) => m !== incoming);
  const transientLoaded = others.filter((m) => plan.transient.includes(m));
  const nonRoster = others.filter((m) => !plan.priority.includes(m));
  const pinnedLoaded = others
    .filter((m) => plan.pinned.includes(m))
    .sort((a, b) => plan.priority.indexOf(b) - plan.priority.indexOf(a));
  return [...transientLoaded, ...nonRoster, ...pinnedLoaded];
}

export function resolveVramBudgetBytes(): number {
  const gb = Number(process.env.MODEL_RESIDENCY_VRAM_GB);
  return Math.round((Number.isFinite(gb) && gb > 0 ? gb : 16) * 1024 ** 3);
}

/** Reads model sizes from Ollama /api/tags (on-disk size ≈ resident weight size). */
export async function fetchModelSizes(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, number>> {
  const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET /api/tags failed: HTTP ${res.status}`);
  const data: any = await res.json();
  const sizes: Record<string, number> = {};
  for (const m of data.models || []) {
    if (m?.name && typeof m.size === "number") sizes[m.name] = m.size;
  }
  return sizes;
}

/** Reads currently loaded models from Ollama /api/ps. */
export async function fetchLoadedModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ name: string; sizeVram: number }[]> {
  const res = await fetchImpl(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET /api/ps failed: HTTP ${res.status}`);
  const data: any = await res.json();
  return (data.models || []).map((m: any) => ({ name: m.name, sizeVram: m.size_vram ?? m.size ?? 0 }));
}

/**
 * Applies the plan before a task run: unloads transient / non-roster models that would
 * block pinned models, then preloads pinned models with the pinned keep_alive.
 * Returns the actions taken (for journals / the morning report).
 */
export async function enforceResidency(
  plan: ResidencyPlan,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const actions: string[] = [];
  const loaded = await fetchLoadedModels(baseUrl, fetchImpl);
  const loadedNames = loaded.map((m) => m.name);
  const sizeOf = (name: string) => loaded.find((m) => m.name === name)?.sizeVram || 0;
  let loadedBytes = loaded.reduce((s, m) => s + m.sizeVram, 0);

  // Bytes still needed for pinned models that are not loaded yet.
  const pinnedLoadedBytes = plan.pinned.filter((m) => loadedNames.includes(m)).reduce((s, m) => s + sizeOf(m), 0);
  const neededBytes = Math.max(0, plan.pinnedBytes - pinnedLoadedBytes);

  // Victims: transient + non-roster models only (never a pinned model), in policy order.
  const victims = evictionOrder(plan, loadedNames, "").filter((m) => !plan.pinned.includes(m));
  for (const victim of victims) {
    if (loadedBytes + neededBytes <= plan.usableBytes) break;
    await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: victim, keep_alive: 0 })
    });
    loadedBytes -= sizeOf(victim);
    actions.push(`unloaded ${victim} (not pinned; freeing VRAM for roster)`);
  }

  for (const model of plan.pinned) {
    if (loadedNames.includes(model)) {
      // Refresh keep_alive so it does not expire mid-task.
      await fetchImpl(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: PINNED_KEEP_ALIVE })
      });
      actions.push(`refreshed ${model} keep_alive=${PINNED_KEEP_ALIVE}`);
      continue;
    }
    await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: PINNED_KEEP_ALIVE })
    });
    actions.push(`preloaded ${model} keep_alive=${PINNED_KEEP_ALIVE}`);
  }

  return actions;
}
