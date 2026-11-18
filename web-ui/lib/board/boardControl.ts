import {
  getBoardControlStore,
  type BoardControlRecord,
  type BoardControlState,
} from "./boardControlStore";

export interface BoardControlReader {
  getState(): BoardControlRecord;
  isRunning(): boolean;
}

/**
 * Reads the persisted ITEM-6 board control state without mutating it.
 */
export function readBoardControlState(boardDir?: string): BoardControlRecord {
  return getBoardControlStore(boardDir).getState();
}

/**
 * Returns true only when the board control state allows draining ("running").
 */
export function isDrainAllowed(
  controlOrState: BoardControlRecord | BoardControlState
): boolean {
  const state =
    typeof controlOrState === "string" ? controlOrState : controlOrState.state;
  return state === "running";
}

/**
 * Maps a non-running board control state to a drain stop reason, or null if running.
 */
export function getControlStopReason(
  state: BoardControlState
): "control-paused" | "control-stopped" | null {
  if (state === "paused") return "control-paused";
  if (state === "stopped") return "control-stopped";
  return null;
}

/**
 * Creates a read-only control reader bound to a board directory.
 */
export function createBoardControlReader(boardDir?: string): BoardControlReader {
  return {
    getState: () => readBoardControlState(boardDir),
    isRunning: () => isDrainAllowed(readBoardControlState(boardDir)),
  };
}
