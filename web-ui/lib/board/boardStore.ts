import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BOARD_SEED_ITEMS } from "./boardSeed";
import { extractThreadIdFromLink } from "./threadLink";
import { atomicWriteFileSync } from "../fsAtomic";

export { extractThreadIdFromLink };

export type BoardStatus = "queued" | "working" | "pr-open" | "parked" | "needs-attention" | "done";
export type BoardSource = "assistant" | "manual";

export const VALID_BOARD_STATUSES: ReadonlySet<BoardStatus> = new Set([
  "queued",
  "working",
  "pr-open",
  "parked",
  "needs-attention",
  "done",
]);

export function isValidBoardStatus(value: unknown): value is BoardStatus {
  return typeof value === "string" && VALID_BOARD_STATUSES.has(value as BoardStatus);
}

export interface BoardEvidence {
  prNumber?: number;
  mergeSha?: string;
  deployTag?: string;
  liveLine?: string;
}

export interface BoardHandoff {
  state: string;
  branch: string;
  headSha: string;
  nextStep: string;
  openQuestions?: string[];
}

export interface BoardItem {
  id: string;
  key: string;
  title: string;
  brief: string;
  dependencies: string[];
  allowlist?: string[];
  status: BoardStatus;
  author: "Owner";
  source: BoardSource;
  parkedReason?: string;
  needsAttention?: boolean;
  evidence?: BoardEvidence;
  threadLink?: string;
  handoff?: BoardHandoff;
  autoResumeCount?: number;
  chunkRequeueCount?: number;
  sprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBoardItemInput {
  id?: string;
  key?: string;
  title: string;
  brief: string;
  dependencies?: string[];
  allowlist?: string[];
  status?: BoardStatus;
  author: "Owner";
  source: BoardSource;
  parkedReason?: string;
  needsAttention?: boolean;
  evidence?: BoardEvidence;
  threadLink?: string;
  handoff?: BoardHandoff;
  autoResumeCount?: number;
  chunkRequeueCount?: number;
  sprint?: string;
}

export interface UpdateBoardItemInput {
  key?: string;
  title?: string;
  brief?: string;
  dependencies?: string[];
  allowlist?: string[];
  status?: BoardStatus;
  parkedReason?: string | null;
  needsAttention?: boolean | null;
  evidence?: BoardEvidence | null;
  threadLink?: string;
  handoff?: BoardHandoff | null;
  autoResumeCount?: number | null;
  chunkRequeueCount?: number | null;
  sprint?: string;
}

/**
 * Returns the set of thread IDs linked from persisted board items without
 * creating directories or running migrations. Used by the stall supervisor
 * so it skips drain-owned threads.
 */
export function listBoardOwnedThreadIds(boardDir?: string): Set<string> {
  const owned = new Set<string>();
  const resolvedDir =
    boardDir ||
    process.env.BOARD_DIR ||
    (process.env.WORKSPACE_DIR
      ? path.resolve(process.env.WORKSPACE_DIR, ".agent/board")
      : path.resolve(process.cwd(), ".agent/board"));
  const filePath = path.join(resolvedDir, "board.json");
  if (!fs.existsSync(filePath)) {
    return owned;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return owned;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return owned;
    for (const item of parsed as Array<{ threadLink?: string }>) {
      const id = extractThreadIdFromLink(item?.threadLink);
      if (id) {
        owned.add(id);
      }
    }
  } catch {
    // Non-fatal: return whatever could be read
  }
  return owned;
}

export function resolveBoardDir(): string {
  let resolvedDir = process.env.BOARD_DIR;
  if (!resolvedDir) {
    resolvedDir = process.env.WORKSPACE_DIR
      ? path.resolve(process.env.WORKSPACE_DIR, ".agent/board")
      : path.resolve(process.cwd(), ".agent/board");
  }
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o770 });
  }
  return resolvedDir;
}

export function isItemEligible(item: BoardItem, allItems: BoardItem[]): boolean {
  if (!item.dependencies || item.dependencies.length === 0) {
    return true;
  }
  const byId = new Map(allItems.map((i) => [i.id, i]));
  return item.dependencies.every((depId) => {
    const dep = byId.get(depId);
    return dep?.status === "done";
  });
}

function allocateNextKey(items: BoardItem[]): string {
  let maxKey = 0;
  for (const item of items) {
    const match = /^#(\d+)$/.exec(item.key.trim());
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxKey) {
        maxKey = num;
      }
    }
  }
  return `#${maxKey + 1}`;
}

export const BOARD_STORE_VERSION = 2;

export class BoardStore {
  private boardDir: string;
  private filePath: string;
  private metaPath: string;

  constructor(boardDir?: string) {
    this.boardDir = boardDir || resolveBoardDir();
    if (!fs.existsSync(this.boardDir)) {
      fs.mkdirSync(this.boardDir, { recursive: true, mode: 0o770 });
    }
    this.filePath = path.join(this.boardDir, "board.json");
    this.metaPath = path.join(this.boardDir, "board.meta.json");
    this.migrateIfNeeded();
  }

  getBoardDir(): string {
    return this.boardDir;
  }

  private migrateIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;
    let currentVersion = 1;
    let existingMeta: Record<string, unknown> = {};
    if (fs.existsSync(this.metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.metaPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingMeta = parsed as Record<string, unknown>;
          if (typeof existingMeta.version === "number") {
            currentVersion = existingMeta.version;
          }
        }
      } catch {
        // Ignore corrupt meta and run migration
      }
    }
    if (currentVersion >= BOARD_STORE_VERSION) return;

    const seedById = new Map(BOARD_SEED_ITEMS.map((item) => [item.id, item]));
    const items = this.readAll();
    let changed = false;
    const now = new Date().toISOString();
    const migrated = items.map((item) => {
      const seed = seedById.get(item.id);
      if (!seed) return item;
      if (
        item.status !== seed.status ||
        JSON.stringify(item.evidence) !== JSON.stringify(seed.evidence)
      ) {
        changed = true;
        return {
          ...item,
          status: seed.status,
          evidence: seed.evidence,
          updatedAt: now,
        };
      }
      return item;
    });
    if (changed) {
      atomicWriteFileSync(this.filePath, JSON.stringify(migrated, null, 2), 0o660);
    }
    atomicWriteFileSync(
      this.metaPath,
      JSON.stringify({ ...existingMeta, version: BOARD_STORE_VERSION }, null, 2),
      0o660
    );
  }

  private readAll(): BoardItem[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  private writeAll(items: BoardItem[]): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(items, null, 2), 0o660);
  }

  list(): BoardItem[] {
    return this.readAll();
  }

  get(id: string): BoardItem | undefined {
    return this.readAll().find((item) => item.id === id);
  }

  create(input: CreateBoardItemInput): BoardItem {
    if (!input.title || !input.title.trim()) {
      throw new Error("Board item requires a title");
    }
    if (!input.brief || !input.brief.trim()) {
      throw new Error("Board item requires a brief");
    }
    if (input.author !== "Owner") {
      throw new Error("Board item requires author 'Owner'");
    }
    if (input.source !== "assistant" && input.source !== "manual") {
      throw new Error("Board item requires source 'assistant' or 'manual'");
    }

    const status: BoardStatus = input.status ?? "queued";
    if (!isValidBoardStatus(status)) {
      throw new Error(`Invalid board status: ${String(status)}`);
    }
    if (status === "parked" && (!input.parkedReason || !input.parkedReason.trim())) {
      throw new Error("Parked board item requires a reason string");
    }

    const items = this.readAll();
    const now = new Date().toISOString();
    const id = input.id || `item-${crypto.randomBytes(4).toString("hex")}`;
    const key = input.key || allocateNextKey(items);

    const normalizedAllowlist = Array.isArray(input.allowlist)
      ? input.allowlist
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
      : undefined;

    const item: BoardItem = {
      id,
      key,
      title: input.title.trim(),
      brief: input.brief.trim(),
      dependencies: input.dependencies ?? [],
      ...(normalizedAllowlist && normalizedAllowlist.length > 0
        ? { allowlist: normalizedAllowlist }
        : {}),
      status,
      author: "Owner",
      source: input.source,
      ...(input.parkedReason ? { parkedReason: input.parkedReason.trim() } : {}),
      ...(input.needsAttention !== undefined ? { needsAttention: input.needsAttention } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.threadLink ? { threadLink: input.threadLink } : {}),
      ...(input.handoff ? { handoff: input.handoff } : {}),
      ...(typeof input.autoResumeCount === "number"
        ? { autoResumeCount: input.autoResumeCount }
        : {}),
      ...(typeof input.chunkRequeueCount === "number"
        ? { chunkRequeueCount: input.chunkRequeueCount }
        : {}),
      ...(input.sprint ? { sprint: input.sprint } : {}),
      createdAt: now,
      updatedAt: now,
    };

    items.push(item);
    this.writeAll(items);
    return item;
  }

  update(id: string, patch: UpdateBoardItemInput): BoardItem {
    if (patch.status !== undefined && !isValidBoardStatus(patch.status)) {
      throw new Error(`Invalid board status: ${String(patch.status)}`);
    }

    const items = this.readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) {
      throw new Error(`Board item not found: ${id}`);
    }

    const current = items[idx];
    const nextStatus = patch.status ?? current.status;
    const isTransitionToClear =
      patch.status === "working" || patch.status === "done" || patch.status === "queued";

    const nextReason =
      patch.parkedReason === null
        ? undefined
        : patch.parkedReason !== undefined
          ? patch.parkedReason
          : isTransitionToClear
            ? undefined
            : current.parkedReason;

    if (nextStatus === "parked" && (!nextReason || !nextReason.trim())) {
      throw new Error("Parked board item requires a reason string");
    }

    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)
    ) as Partial<BoardItem>;

    const updated: BoardItem = {
      ...current,
      ...definedPatch,
      status: nextStatus,
      ...(nextReason !== undefined ? { parkedReason: nextReason.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };

    if (patch.handoff === null) {
      delete updated.handoff;
    }
    if (patch.parkedReason === null || (isTransitionToClear && patch.parkedReason === undefined)) {
      delete updated.parkedReason;
    }
    if (
      patch.needsAttention === null ||
      (isTransitionToClear && patch.needsAttention === undefined)
    ) {
      delete updated.needsAttention;
    }
    if (patch.autoResumeCount === null) {
      delete updated.autoResumeCount;
    }
    if (patch.chunkRequeueCount === null) {
      delete updated.chunkRequeueCount;
    }
    if (patch.evidence === null) {
      delete updated.evidence;
    } else if (patch.evidence !== undefined) {
      const mergedEvidence = Object.fromEntries(
        Object.entries({ ...(current.evidence ?? {}), ...patch.evidence }).filter(
          ([, v]) => v !== undefined
        )
      ) as BoardEvidence;
      if (Object.keys(mergedEvidence).length > 0) {
        updated.evidence = mergedEvidence;
      } else {
        delete updated.evidence;
      }
    }

    items[idx] = updated;
    this.writeAll(items);
    return updated;
  }

  remove(id: string): BoardItem {
    const items = this.readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) {
      throw new Error(`Board item not found: ${id}`);
    }
    const [removed] = items.splice(idx, 1);
    this.writeAll(items);
    return removed;
  }
}

let defaultStore: BoardStore | null = null;

export function getBoardStore(): BoardStore {
  const desiredDir = resolveBoardDir();
  if (!defaultStore || defaultStore.getBoardDir() !== desiredDir) {
    defaultStore = new BoardStore(desiredDir);
  }
  return defaultStore;
}

export function fileBoardItem(
  input: CreateBoardItemInput,
  store: BoardStore = getBoardStore()
): BoardItem {
  return store.create({
    ...input,
    status: "queued",
  });
}

export function seedBoardIfEmpty(store: BoardStore = getBoardStore()): BoardItem[] {
  const existing = store.list();
  if (existing.length > 0) {
    return existing;
  }
  for (const seed of BOARD_SEED_ITEMS) {
    store.create(seed);
  }
  return store.list();
}
