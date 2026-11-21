import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BoardStore, getBoardStore, type BoardItem } from "./boardStore";
import {
  BoardControlStore,
  getBoardControlStore,
  type BoardControlRecord,
} from "./boardControlStore";
import { PrioritySlotScheduler, SlotPriority, getSharedSlotScheduler } from "../slotScheduler";
import { createLlmGenerate, type GenerateFn } from "../subagents/llmClient";
import { DEFAULT_PRIMARY_MODEL } from "../../config/models";

export interface IntakeStackItem {
  tempKey?: string;
  title: string;
  brief: string;
  dependencies: string[];
  fileAllowlist: string[];
  acceptanceCriteria: string[];
}

export interface IntakePreviewRequest {
  prompt: string;
  repoMapSummary?: string;
  model?: string;
}

export interface IntakePreviewResult {
  items: IntakeStackItem[];
  model: string;
}

export interface IntakeConfirmRequest {
  items: IntakeStackItem[];
  startDrain?: boolean;
}

export interface IntakeConfirmResult {
  items: BoardItem[];
  control?: BoardControlRecord;
}

export interface MonsterIntakeDeps {
  store?: BoardStore;
  controlStore?: BoardControlStore;
  scheduler?: PrioritySlotScheduler;
  generateFn?: GenerateFn;
  repoRoot?: string;
}

export class IntakeValidationError extends Error {
  readonly statusCode = 400;
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Intake validation failed: ${reasons.join("; ")}`);
    this.name = "IntakeValidationError";
    this.reasons = reasons;
  }
}

export class IntakeModelError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "IntakeModelError";
  }
}

/**
 * Resilient JSON repair and parser for intake responses, modeled after
 * `repairAndParsePlanJson` in `lib/subagents/planner.ts` (which is scoped to
 * `{ milestones }`) without modifying planner.ts.
 *
 * Handles markdown code fences, `<think>` blocks, and tail truncation
 * (unclosed strings / brackets / braces).
 */
export function repairAndParseIntakeJson(rawText: string): { items: unknown[] } | null {
  if (!rawText || typeof rawText !== "string") return null;

  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  if (!cleaned) return null;

  // 1. Direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).items)) {
      return { items: (parsed as any).items };
    }
  } catch {
    // Fall through to extraction & repair
  }

  // 2. Extract JSON object substring starting at first '{'
  const startIdx = cleaned.indexOf("{");
  if (startIdx === -1) return null;
  const endIdx = cleaned.lastIndexOf("}");
  const candidate =
    endIdx > startIdx ? cleaned.slice(startIdx, endIdx + 1) : cleaned.slice(startIdx);

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).items)) {
      return { items: (parsed as any).items };
    }
  } catch {
    // Fall through to truncation repair
  }

  // 3. Truncation repair: close unclosed quotes and balance braces/brackets
  try {
    let repaired = cleaned.slice(startIdx).trim().replace(/,\s*$/, "");

    // Close unclosed string if quote count is odd
    let inString = false;
    let escaped = false;
    const stack: string[] = [];

    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") {
          if (stack.length > 0 && stack[stack.length - 1] === ch) {
            stack.pop();
          }
        }
      }
    }

    if (inString) {
      repaired += '"';
    }
    repaired = repaired.replace(/,\s*$/, "");
    while (stack.length > 0) {
      repaired += stack.pop();
    }

    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).items)) {
      return { items: (parsed as any).items };
    }
  } catch {
    // Unable to repair
  }

  return null;
}

/**
 * Strictly validates an intake stack before preview or filing.
 * Rejects missing/empty acceptanceCriteria, missing/empty fileAllowlist,
 * empty title/brief, unknown dependency keys, and cyclic dependencies.
 */
export function validateIntakeStack(
  rawItems: unknown,
  existingItems: BoardItem[]
): IntakeStackItem[] {
  const reasons: string[] = [];

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new IntakeValidationError(["Stack must contain at least one item"]);
  }

  const normalized: IntakeStackItem[] = [];
  const seenTempKeys = new Set<string>();

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const label = `item[${i}]`;

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      reasons.push(`${label} must be an object`);
      continue;
    }

    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const brief = typeof obj.brief === "string" ? obj.brief.trim() : "";

    if (!title) {
      reasons.push(`${label} has empty or missing title`);
    }
    if (!brief) {
      reasons.push(`${label} has empty or missing brief`);
    }

    const rawAllowlist = obj.fileAllowlist;
    const fileAllowlist = Array.isArray(rawAllowlist)
      ? rawAllowlist
          .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
          .map((f) => f.trim())
      : [];
    if (fileAllowlist.length === 0) {
      reasons.push(`${label} (${title || "untitled"}) is missing non-empty fileAllowlist`);
    }

    const rawCriteria = obj.acceptanceCriteria;
    const acceptanceCriteria = Array.isArray(rawCriteria)
      ? rawCriteria
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim())
      : [];
    if (acceptanceCriteria.length === 0) {
      reasons.push(`${label} (${title || "untitled"}) is missing non-empty acceptanceCriteria`);
    }

    let dependencies: string[] = [];
    if (obj.dependencies !== undefined) {
      if (!Array.isArray(obj.dependencies)) {
        reasons.push(`${label} (${title || "untitled"}) dependencies must be an array of strings`);
      } else {
        for (const dep of obj.dependencies) {
          if (typeof dep !== "string" || !dep.trim()) {
            reasons.push(`${label} (${title || "untitled"}) contains an invalid dependency entry`);
          } else {
            dependencies.push(dep.trim());
          }
        }
      }
    }

    const tempKey =
      typeof obj.tempKey === "string" && obj.tempKey.trim() ? obj.tempKey.trim() : `STACK-${i + 1}`;

    if (seenTempKeys.has(tempKey)) {
      reasons.push(`Duplicate stack key "${tempKey}"`);
    }
    seenTempKeys.add(tempKey);

    normalized.push({
      tempKey,
      title,
      brief,
      dependencies,
      fileAllowlist,
      acceptanceCriteria,
    });
  }

  if (reasons.length > 0) {
    throw new IntakeValidationError(reasons);
  }

  // Build lookup of known keys: existing board items (by key or id) + stack items (by tempKey)
  const existingKeys = new Set<string>();
  for (const item of existingItems) {
    existingKeys.add(item.key);
    existingKeys.add(item.id);
  }

  const stackIndexByKey = new Map<string, number>();
  for (let i = 0; i < normalized.length; i++) {
    stackIndexByKey.set(normalized[i].tempKey!, i);
  }

  // Validate all dependency references exist
  for (let i = 0; i < normalized.length; i++) {
    const item = normalized[i];
    for (const dep of item.dependencies) {
      if (!existingKeys.has(dep) && !stackIndexByKey.has(dep)) {
        reasons.push(`Unknown dependency key "${dep}" on ${item.tempKey} (${item.title})`);
      }
    }
  }

  if (reasons.length > 0) {
    throw new IntakeValidationError(reasons);
  }

  // Cycle detection on intra-stack dependencies (0 = unvisited, 1 = visiting, 2 = visited)
  const state = new Array<number>(normalized.length).fill(0);
  const dfs = (idx: number, trail: string[]): boolean => {
    state[idx] = 1;
    const item = normalized[idx];
    for (const dep of item.dependencies) {
      const targetIdx = stackIndexByKey.get(dep);
      if (targetIdx === undefined) continue; // Pre-existing board item (DAG external)
      if (state[targetIdx] === 1) {
        const cyclePath = [...trail, item.tempKey!, normalized[targetIdx].tempKey!].join(" -> ");
        reasons.push(`Cyclic dependency detected: ${cyclePath}`);
        return true;
      }
      if (state[targetIdx] === 0) {
        if (dfs(targetIdx, [...trail, item.tempKey!])) {
          return true;
        }
      }
    }
    state[idx] = 2;
    return false;
  };

  for (let i = 0; i < normalized.length; i++) {
    if (state[i] === 0) {
      dfs(i, []);
    }
  }

  if (reasons.length > 0) {
    throw new IntakeValidationError(reasons);
  }

  return normalized;
}

function buildShortRepoMapSummary(repoRoot?: string): string {
  const root = repoRoot || process.env.WORKSPACE_DIR || process.cwd();
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .slice(0, 20)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return `Top-level entries: ${entries.join(", ")}`;
  } catch {
    return "Repository root summary unavailable.";
  }
}

function buildIntakePrompt(
  ownerPrompt: string,
  existingItems: BoardItem[],
  repoMapSummary: string
): string {
  const existingLines =
    existingItems.length > 0
      ? existingItems
          .slice(0, 40)
          .map((i) => `- ${i.key}: ${i.title} [${i.status}]`)
          .join("\n")
      : "(none)";

  return [
    "You are a technical orchestrator decomposing an owner's request into an ordered stack of board items.",
    "Return ONLY valid JSON matching this exact schema:",
    '{"items":[{"tempKey":"S1","title":"...","brief":"...","dependencies":[],"fileAllowlist":["path/to/file"],"acceptanceCriteria":["..."]}]}',
    "",
    "Rules:",
    "- Output an ordered array `items` (at least 1 item).",
    "- Every item MUST have non-empty `title`, `brief`, `fileAllowlist` (array of file paths), and `acceptanceCriteria` (array of testable criteria).",
    "- `dependencies` is an array of keys referencing either an existing board item key below or an earlier item's `tempKey` in this stack. Never create cycles or reference unknown keys.",
    "- Output raw JSON only, no prose outside the JSON object.",
    "",
    "Repository summary:",
    repoMapSummary,
    "",
    "Existing board items (for dependency linking):",
    existingLines,
    "",
    "Owner request:",
    ownerPrompt.trim(),
  ].join("\n");
}

/**
 * Runs ONE bounded orchestrator-priority model call (P2_ORCHESTRATOR,
 * reasoning_effort: "low", max_tokens: 4096, JSON output) to decompose an
 * owner's prompt into a strictly validated preview stack.
 *
 * Performs ZERO writes to the board store and NEVER retries on malformed output.
 */
export async function previewMonsterIntake(
  input: IntakePreviewRequest,
  deps: MonsterIntakeDeps = {}
): Promise<IntakePreviewResult> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new IntakeValidationError(["Prompt is required"]);
  }

  const store = deps.store ?? getBoardStore();
  const scheduler = deps.scheduler ?? getSharedSlotScheduler();
  const generateFn = deps.generateFn ?? createLlmGenerate({ scope: "PROJECT" });

  // Read-only snapshot of existing board items
  const existingItems = store.list();
  const repoMapSummary = input.repoMapSummary?.trim() || buildShortRepoMapSummary(deps.repoRoot);
  const fullPrompt = buildIntakePrompt(prompt, existingItems, repoMapSummary);

  const model =
    input.model ||
    process.env.ORCHESTRATOR_MODEL ||
    process.env.PLANNER_MODEL ||
    process.env.MODEL_NAME ||
    DEFAULT_PRIMARY_MODEL;

  // Exactly ONE bounded model call at P2_ORCHESTRATOR priority. No retry loop.
  const result = await scheduler.runWithSlot(
    {
      priority: SlotPriority.P2_ORCHESTRATOR,
      label: "board:intake",
    },
    async () =>
      generateFn({
        model,
        prompt: fullPrompt,
        format: "json",
        reasoningEffort: "low",
        scope: "PROJECT",
        options: {
          num_predict: 4096,
          temperature: 0.1,
          reasoning_effort: "low",
        },
      })
  );

  const parsed = repairAndParseIntakeJson(result.text);
  if (!parsed) {
    throw new IntakeModelError(
      "Malformed model output: response could not be parsed as a valid JSON stack"
    );
  }

  const validated = validateIntakeStack(parsed.items, existingItems);
  return {
    items: validated,
    model: result.model || model,
  };
}

function formatFiledBrief(item: IntakeStackItem): string {
  const parts = [item.brief.trim()];
  if (item.fileAllowlist.length > 0) {
    parts.push(`Files: ${item.fileAllowlist.join(", ")}`);
  }
  if (item.acceptanceCriteria.length > 0) {
    parts.push(`Acceptance:\n${item.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Atomically files all N validated stack items into the board store with
 * `author: "Owner"`, `source: "assistant"`, `status: "queued"`, and resolved
 * dependency IDs (both pre-existing board items and intra-stack items).
 *
 * If any item fails validation, ZERO items are written.
 * If `startDrain` is true, transitions the existing BoardControlStore to `running`.
 */
export async function confirmMonsterIntake(
  input: IntakeConfirmRequest,
  deps: MonsterIntakeDeps = {}
): Promise<IntakeConfirmResult> {
  const store = deps.store ?? getBoardStore();
  const existingItems = store.list();

  // Strict pre-validation before any write occurs
  const validated = validateIntakeStack(input.items, existingItems);

  // Build ID lookup for pre-existing items (by key and by id)
  const keyToId = new Map<string, string>();
  for (const existing of existingItems) {
    keyToId.set(existing.key, existing.id);
    keyToId.set(existing.id, existing.id);
  }

  // Pre-allocate IDs for all new stack items so intra-stack dependencies resolve cleanly
  const allocatedIds: string[] = validated.map(
    () => `item-${crypto.randomBytes(4).toString("hex")}`
  );
  for (let i = 0; i < validated.length; i++) {
    keyToId.set(validated[i].tempKey!, allocatedIds[i]);
  }

  const created: BoardItem[] = [];
  for (let i = 0; i < validated.length; i++) {
    const item = validated[i];
    const resolvedDeps = item.dependencies.map((depKey) => {
      const id = keyToId.get(depKey);
      if (!id) {
        throw new IntakeValidationError([
          `Unable to resolve dependency "${depKey}" on ${item.tempKey}`,
        ]);
      }
      return id;
    });

    const filed = store.create({
      id: allocatedIds[i],
      title: item.title,
      brief: formatFiledBrief(item),
      dependencies: resolvedDeps,
      ...(item.fileAllowlist.length > 0 ? { allowlist: item.fileAllowlist } : {}),
      status: "queued",
      author: "Owner",
      source: "assistant",
    });
    created.push(filed);
  }

  let control: BoardControlRecord | undefined;
  if (input.startDrain) {
    const controlStore = deps.controlStore ?? getBoardControlStore();
    const applied = await controlStore.applyAction("start");
    control = applied.control;
  }

  return {
    items: created,
    ...(control ? { control } : {}),
  };
}
