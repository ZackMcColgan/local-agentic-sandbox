import fs from "node:fs";
import path from "node:path";
import { resolveBoardDir, BoardStore } from "./boardStore";
import { abortActiveTurn, clearTurnActive, activeExecutionSet } from "../threads/threadStore";
import { cancelTask } from "../subagents/supervisor";
import { unloadAllModels } from "../subagents/residency";

export type BoardControlState = "running" | "paused" | "stopped";
export type BoardControlAction = "start" | "pause" | "stop";

export interface BoardControlRecord {
  state: BoardControlState;
  drainBudget: number | null;
  stopAtBoundary: boolean;
  updatedAt: string;
  lastAction?: BoardControlAction;
}

export interface BoardStopAbortResult {
  abortedTurns: string[];
  cancelledTasks: string[];
  unloadedModels: string[];
}

export interface BoardControlApplyResult {
  control: BoardControlRecord;
  abortResult?: BoardStopAbortResult;
}

export interface BoardControlActionOptions {
  drainBudget?: number | null;
  threadId?: string;
  taskId?: string;
}

export interface BoardControlDeps {
  abortTurn?: (threadId: string) => boolean;
  clearTurn?: (threadId: string) => void;
  cancelTaskFn?: (taskId: string) => boolean;
  unloadModels?: () => Promise<string[]>;
}

const VALID_STATES = new Set<BoardControlState>(["running", "paused", "stopped"]);
const VALID_ACTIONS = new Set<BoardControlAction>(["start", "pause", "stop"]);

export function isValidBoardControlAction(value: unknown): value is BoardControlAction {
  return typeof value === "string" && VALID_ACTIONS.has(value as BoardControlAction);
}

function defaultControlRecord(): BoardControlRecord {
  const envAutoIssue = process.env.DISPATCHER_AUTO_ISSUE === "true";
  return {
    state: envAutoIssue ? "running" : "stopped",
    drainBudget: null,
    stopAtBoundary: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export function extractThreadIdFromLink(threadLink?: string): string | null {
  if (!threadLink) return null;
  const trimmed = threadLink.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed, "http://localhost");
    const queryId = parsed.searchParams.get("thread")?.trim();
    if (queryId) {
      return queryId;
    }
    const legacyMatch = /^\/threads\/([^/]+)\/?$/.exec(parsed.pathname);
    if (legacyMatch) {
      const legacyId = decodeURIComponent(legacyMatch[1]).trim();
      if (legacyId) {
        return legacyId;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export class BoardControlStore {
  private boardDir: string;
  private metaPath: string;
  private deps: Required<BoardControlDeps>;

  constructor(boardDir?: string, deps: BoardControlDeps = {}) {
    this.boardDir = boardDir || resolveBoardDir();
    if (!fs.existsSync(this.boardDir)) {
      fs.mkdirSync(this.boardDir, { recursive: true, mode: 0o770 });
    }
    this.metaPath = path.join(this.boardDir, "board.meta.json");
    this.deps = {
      abortTurn: deps.abortTurn ?? abortActiveTurn,
      clearTurn: deps.clearTurn ?? clearTurnActive,
      cancelTaskFn: deps.cancelTaskFn ?? cancelTask,
      unloadModels: deps.unloadModels ?? (() => unloadAllModels()),
    };
  }

  private readMeta(): Record<string, unknown> {
    if (!fs.existsSync(this.metaPath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(this.metaPath, "utf8");
      if (!raw.trim()) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private writeControl(record: BoardControlRecord): void {
    const existing = this.readMeta();
    const nextMeta = {
      ...existing,
      control: record,
    };
    fs.writeFileSync(this.metaPath, JSON.stringify(nextMeta, null, 2), {
      encoding: "utf8",
      mode: 0o660,
    });
  }

  getState(): BoardControlRecord {
    const meta = this.readMeta();
    const raw = meta.control as Partial<BoardControlRecord> | undefined;
    if (!raw || typeof raw !== "object" || !VALID_STATES.has(raw.state as BoardControlState)) {
      return defaultControlRecord();
    }
    return {
      state: raw.state as BoardControlState,
      drainBudget:
        typeof raw.drainBudget === "number" && Number.isFinite(raw.drainBudget)
          ? raw.drainBudget
          : null,
      stopAtBoundary: Boolean(raw.stopAtBoundary),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      ...(raw.lastAction && VALID_ACTIONS.has(raw.lastAction)
        ? { lastAction: raw.lastAction }
        : {}),
    };
  }

  isAutoIssueAllowed(): boolean {
    return this.getState().state === "running";
  }

  private collectActiveThreadIds(explicitThreadId?: string): string[] {
    const ids = new Set<string>();
    if (explicitThreadId) ids.add(explicitThreadId);

    const g = globalThis as Record<string, unknown>;
    const turnRegistry = g.__sandboxActiveTurnRegistry as Map<string, unknown> | undefined;
    if (turnRegistry) {
      for (const id of turnRegistry.keys()) ids.add(id);
    }
    const turnControllers = g.__sandboxActiveTurnAbortControllers as
      Map<string, unknown> | undefined;
    if (turnControllers) {
      for (const id of turnControllers.keys()) ids.add(id);
    }
    for (const id of activeExecutionSet) {
      ids.add(id);
    }

    try {
      const boardItems = new BoardStore(this.boardDir).list();
      for (const item of boardItems) {
        if (item.status === "working") {
          const linked = extractThreadIdFromLink(item.threadLink);
          if (linked) ids.add(linked);
        }
      }
    } catch {
      // Ignore board read errors during emergency stop
    }

    return Array.from(ids);
  }

  private collectActiveTaskIds(explicitTaskId?: string): string[] {
    const ids = new Set<string>();
    if (explicitTaskId) ids.add(explicitTaskId);

    const g = globalThis as Record<string, unknown>;
    const supState = g.__supervisorGlobalState as
      { abortControllers?: Map<string, unknown> } | undefined;
    if (supState?.abortControllers) {
      for (const id of supState.abortControllers.keys()) ids.add(id);
    }

    return Array.from(ids);
  }

  async applyAction(
    action: BoardControlAction,
    options: BoardControlActionOptions = {}
  ): Promise<BoardControlApplyResult> {
    const current = this.getState();
    const now = new Date().toISOString();

    if (action === "start") {
      const nextBudget =
        options.drainBudget !== undefined ? options.drainBudget : current.drainBudget;
      const next: BoardControlRecord = {
        state: "running",
        drainBudget: nextBudget ?? null,
        stopAtBoundary: false,
        updatedAt: now,
        lastAction: "start",
      };
      this.writeControl(next);
      return { control: next };
    }

    if (action === "pause") {
      // Pause halts next-item issuance at the current chunk/round boundary without aborting active turns.
      const next: BoardControlRecord = {
        state: "paused",
        drainBudget: current.drainBudget,
        stopAtBoundary: true,
        updatedAt: now,
        lastAction: "pause",
      };
      this.writeControl(next);
      return { control: next };
    }

    // Stop: persist stopped state AND immediately abort active server-side turn + task + unload models.
    const next: BoardControlRecord = {
      state: "stopped",
      drainBudget: current.drainBudget,
      stopAtBoundary: false,
      updatedAt: now,
      lastAction: "stop",
    };
    this.writeControl(next);

    const abortedTurns: string[] = [];
    for (const threadId of this.collectActiveThreadIds(options.threadId)) {
      this.deps.clearTurn(threadId);
      if (this.deps.abortTurn(threadId)) {
        abortedTurns.push(threadId);
      }
      activeExecutionSet.delete(threadId);
    }

    const cancelledTasks: string[] = [];
    for (const taskId of this.collectActiveTaskIds(options.taskId)) {
      if (this.deps.cancelTaskFn(taskId)) {
        cancelledTasks.push(taskId);
      }
      activeExecutionSet.delete(taskId);
    }

    const unloadedModels = await this.deps.unloadModels();

    return {
      control: next,
      abortResult: {
        abortedTurns,
        cancelledTasks,
        unloadedModels,
      },
    };
  }
}

export function getBoardControlStore(boardDir?: string): BoardControlStore {
  return new BoardControlStore(boardDir);
}
