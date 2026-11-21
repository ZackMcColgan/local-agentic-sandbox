import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BOARD_SEED_ITEMS } from "./boardSeed";

export type BoardStatus = "queued" | "working" | "pr-open" | "parked" | "needs-attention" | "done";
export type BoardSource = "assistant" | "manual";

export interface BoardEvidence {
  prNumber?: number;
  mergeSha?: string;
  deployTag?: string;
  liveLine?: string;
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
  sprint?: string;
}

export interface UpdateBoardItemInput {
  key?: string;
  title?: string;
  brief?: string;
  dependencies?: string[];
  allowlist?: string[];
  status?: BoardStatus;
  parkedReason?: string;
  needsAttention?: boolean;
  evidence?: BoardEvidence;
  threadLink?: string;
  sprint?: string;
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

  private migrateIfNeeded(): void {
    if (!fs.existsSync(this.filePath)) return;
    let currentVersion = 1;
    if (fs.existsSync(this.metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(this.metaPath, "utf8")) as { version?: number };
        if (typeof meta.version === "number") {
          currentVersion = meta.version;
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
      if (item.status !== seed.status || JSON.stringify(item.evidence) !== JSON.stringify(seed.evidence)) {
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
      fs.writeFileSync(this.filePath, JSON.stringify(migrated, null, 2), "utf8");
    }
    fs.writeFileSync(this.metaPath, JSON.stringify({ version: BOARD_STORE_VERSION }, null, 2), "utf8");
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
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), {
      encoding: "utf8",
      mode: 0o660,
    });
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
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.threadLink ? { threadLink: input.threadLink } : {}),
      ...(input.sprint ? { sprint: input.sprint } : {}),
      createdAt: now,
      updatedAt: now,
    };

    items.push(item);
    this.writeAll(items);
    return item;
  }

  update(id: string, patch: UpdateBoardItemInput): BoardItem {
    const items = this.readAll();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) {
      throw new Error(`Board item not found: ${id}`);
    }

    const current = items[idx];
    const nextStatus = patch.status ?? current.status;
    const nextReason =
      patch.parkedReason !== undefined ? patch.parkedReason : current.parkedReason;

    if (nextStatus === "parked" && (!nextReason || !nextReason.trim())) {
      throw new Error("Parked board item requires a reason string");
    }

    const updated: BoardItem = {
      ...current,
      ...patch,
      status: nextStatus,
      ...(nextReason !== undefined ? { parkedReason: nextReason.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };

    items[idx] = updated;
    this.writeAll(items);
    return updated;
  }
}

let defaultStore: BoardStore | null = null;

export function getBoardStore(): BoardStore {
  if (!defaultStore) {
    defaultStore = new BoardStore();
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
