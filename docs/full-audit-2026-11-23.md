# Full-Spectrum Audit — `develop` @ `b64022ac` (2026-11-23)

- **Audit Date:** 2026-11-23
- **Target Branch / Commit:** `develop` @ `b64022ac0da2be501343fb566092ef17ee09eab2` (`b64022ac`, deployed production tree)
- **Mode:** Strictly read-only across product code, runtime processes, and live board state. All `file:line` citations and counts are verified directly against `b64022ac`.
- **Prior Baseline Audits Verified:**
  - `docs/runtime-audit-2026-11-22.md` (`F1–F13`, addressed across PRs #216, #220, #223, #226)
  - `docs/ui-audit-2026-11-22.md` (`U1–U17`; Iterations 1–2 shipped in PR #224, Iterations 3–5 unbuilt)
  - `docs/prefix-reuse-investigation-2026-11-23.md` (Sinks `#1–#8` / `P0–P6`, shipped across PRs #227, #229, #230, #232, #233, #234, #235)

---

## Executive Summary

1. **Three critical runtime/state defects and two broken perf-program mechanisms require immediate remediation before unattended marathon runs:**
   - **Slot-release listener collision (`R1`, `critical`, PR #234):** `PrioritySlotScheduler` stores both `onWaitRelease` and `onWaitReacquire` inside a single `Set` (`web-ui/lib/slotScheduler.ts:121, 143-148, 180-185`). Entering `lease.releaseForWait()` fires `queue.beginOverlap()` (recursively starting **all** pending turns in `JobQueue`, not one) and immediately fires `queue.endOverlap()` (`overlapDepth` `1 -> 0`) before the tool wait begins; re-acquiring the slot fires `beginOverlap()` again while the engine is busy. Overlapping turns can also collide on the same `threadId`, shared `/workspace`, and shared `HOST_CHECKOUT_PATH` (`R5`, `high`).
   - **False `"done"` board completion on deleted or non-terminal threads (`R2`, `critical`, incomplete `F7`):** `evaluateSettledThreadOutcome` (`web-ui/lib/board/productionDrain.ts:401-433`) only rejects `!response.ok` or `thread?.status === "failed" | "stopped"`. Deleting an in-flight job thread (`thread === null`) or settling in `"paused"` / `"active"` / `"running"` falls through to `{ status: "completed" }` and stamps the board item `"done"`.
   - **Ephemeral SQLite pod storage & unreconciled project locks (`R3`, `critical`):** `deploy/k8s/web-ui.yaml:40-120` omits `RUN_LEDGER_DB_PATH` and `USER_PROFILE_PATH`, placing `runs.db` (`Projects`, `project_tasks`, `RunLedger`, `FlywheelSkillsStore`, `SelfDeployPipeline`) on `/home/nextjs/.local-agentic-sandbox/` ephemeral overlay storage wiped on every pod rollout, while `project_tasks` lacks startup crash reconciliation (locking `projects.active_task_id` with HTTP 409).
   - **Synchronous multi-MB double writes in `touchActiveTurn` (`P-F1`, `critical`) & unwired `P6` estimate cache (`P-F2`, `high`, PR #235):** `touchActiveTurn` (`web-ui/lib/threads/threadStore.ts:86-95`) synchronously reads, parses, and pretty-prints the entire 1.5–5.0 MB thread JSON (non-atomically, busting `.summaries-index.json` mtime cache) every 30s and on the very next line (`roundLoop.ts:2263`) after `streamSnapshot.maybeWrite(..., { force: true })` (`2246-2261`) just wrote the same file. Meanwhile, PR #235 wired `precomputedRawMessageTokens` into `contextBudget.ts` (`runChatToolLoop`) **but never into `roundLoop.ts` or `turnEngine.ts`**, leaving **7–10+ full-history `JSON.stringify` scans per production round**.
2. **Parallel tool rounds (`P2`) and `< 70K` prefix preservation (`P0`) work, but multi-tool message invariants and `P3`/`P4` edge paths have high-severity bugs:**
   - `roundLoop.ts` omits `tool_call_id` on `role: "tool"` messages (`R4`, causing `microElision.ts:347` to pair every tool result in a batch with `tool_calls[0]`), injects `appendTrailingDirective` (`role: "user"`) mid-batch between `tool` results (`1665, 1674, 1701, 1948`), re-pushes `currentAssistantMessage` with unpaired `tool_calls` right before synthesis (`2400`), and leaves barrier MCP `callTool` (`2204`) unguarded by `try/catch`.
   - `P4` poll suppression (`page.tsx:528-555`, `P-F3`) wakes back up `1,500 ms` into every 20–53s LLM prefill and every 5–60s tool batch because `lastStreamChunkAtRef` only tracks `[messages]` updates. `P3` (`R9`, `P-F6`, `U-F3`) suppresses the complete round-end `thought` SSE event whenever token 1 flushes a snapshot (`roundLoop.ts:1165-1172, 1266`), still builds cumulative thought strings eagerly per token before the 5s timer check, and `ChatStream.tsx:1194` wipes live `msg.thought` to `undefined` on the first `token` event.
3. **Both known open UI defects are traced end-to-end, alongside open Iterations 3–5 and Design Lock breaches:**
   - **Defect (a) (`U-F1`, `high`):** Unguarded `powershell.exe` invocation (`host-bridge/server.ts:558`), naive `"exit_code":1` / `"status":"EXECUTION_ERROR"` substring matching (`roundLoop.ts:1558-1559`), missing `TraceItem.isError` persistence (`1586-1595`), and `extractTraceError` heuristics (`activityTimeline.ts:301-335`) both paint `0`-exit native `stderr` progress rose under `$ErrorActionPreference = 'Stop'` and invert failed sandbox `workspace_run_command` results to green.
   - **Defect (b) (`U-F2`, `high`):** `extractTraceError` flattens newlines and truncates errors at `MAX_ERROR_LEN = 140` chars (`activityTimeline.ts:69-75`), `ActivityTimeline.tsx` never renders `row.traceResult`, and six `<pre>`/error containers lack `max-h-* overflow-y-auto overscroll-contain`.

---

## Section 1 — Track 1: Full Code & Runtime Audit

### 1.1 Verification of Closed Runtime Audit Findings (`F1–F13`)

| Prior ID | Shipped PR(s) | Status at `b64022ac`                                                    | Verification Evidence (`file:line`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| :------- | :------------ | :---------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**   | #216          | **Substantially Closed** _(gaps in `R8`)_                               | `onThreadCreated` atomically saves `status: "working"` + `threadLink` (`web-ui/lib/board/productionDrain.ts:678`, `web-ui/lib/board/boardOrchestrator.ts:763-768`); orphan recovery requeues up to `MAX_ORPHAN_AUTO_RESUMES = 2` (`boardOrchestrator.ts:680-717`). Residual gaps: `drain()` exits before liveness check when `boardControl` is paused/stopped (`479-484`), orphan brief slices at 600 chars (`694`), and PR trace check looks for `"host_create_pr"` instead of `"host_git_pr_create"` (`productionDrain.ts:294`). |
| **F2**   | #216, #231    | **Closed for Board** _(legacy `taskId` gap in `R10`)_                   | Board threads stamp `boardItemId` (`productionDrain.ts:673`), are excluded from `inAppSupervisor` (`web-ui/lib/threads/threadStore.ts:599-616`, `web-ui/lib/threads/inAppSupervisor.ts:146-148`), and retain host tools on resume (`web-ui/lib/chat/roundLoop.ts:449-451`). Residual: `sweepStalledThreads` still calls `getThread()` -> `reconcileThread()` before `superviseStalledThread()` for non-board `taskId` threads (`threadStore.ts:607`).                                                                              |
| **F3**   | #214, #216    | **Substantially Closed** _(gaps in `R8`)_                               | `[[CHUNK_COMPLETE]]` is detected ahead of `stopped` short-circuits (`productionDrain.ts:366-373, 487-500`) and `bankGit: Boolean(_worktree)` skips `/app` git pushes (`roundLoop.ts:758`). Residual: `chunkWorkspaceRoot` falls back to `/app` (`roundLoop.ts:734-740`, ephemeral runlog + `"HEAD"`/`"unknown"` metadata), `composeDispatcherBrief` omits `item.brief` when `handoff` is present (`web-ui/lib/board/dispatcher.ts:108-127`), and chunk requeues are uncapped (`boardOrchestrator.ts:601-617, 881-897`).            |
| **F4**   | #220          | **Closed** _(minor residual in `R12`)_                                  | 30s unreffed `inTurnHeartbeatTimer` (`roundLoop.ts:337-348, 2865-2868`), 30s `executeHostTool` `onHeartbeat` (`web-ui/lib/hostMode.ts:363, 426-459`), `toolCallProgress` deadline re-arm (`web-ui/lib/llm/provider.ts:881-888, 920-927`, `roundLoop.ts:1214-1217`), and `queuedForExecution` stall-clock gating (`web-ui/app/api/chat/route.ts:266`, `web-ui/lib/threads/liveness.ts:56`) are sound.                                                                                                                               |
| **F5**   | #220          | **Closed & Sound**                                                      | `createSseEventWriter` drops only the write stream when `inProcessConsumer: true` (`web-ui/lib/chat/turnEngine.ts:152-161`) and `defaultDispatchChatTurn` awaits `waitForTurnSettled` (`productionDrain.ts:556-565`).                                                                                                                                                                                                                                                                                                              |
| **F6**   | #224          | **Closed & Sound**                                                      | `ChatStream.tsx:549-575, 1080-1100` unifies `isTurnLive`, refreshes activity on SSE `ping`, and derives observed liveness from `observedThreadUpdatedAt`.                                                                                                                                                                                                                                                                                                                                                                          |
| **F7**   | #216, #220    | **Incomplete Closure** _(see `R2`)_                                     | `classifyJobSummary` precedes `stopped` checks (`productionDrain.ts:378-399`) and `extractTurnFailureReason` surfaces real markers (`184-222`), **but** `evaluateSettledThreadOutcome` falls through to `"completed"` when `thread === null` or status is `"paused"`/`"active"`/`"running"` (`401-433`).                                                                                                                                                                                                                           |
| **F8**   | #226          | **Substantially Closed** _(multi-tool & directive edges in `R4`, `R9`)_ | Measured `promptTokens` calibration (`web-ui/lib/contextBudget.ts:226-285`), `ROUND_MAX_TOKENS` output headroom (`586-596, 1099-1106`), 3-pass micro-elision (`web-ui/lib/microElision.ts:367-571`), `liveMessages` hybrid compaction (`web-ui/lib/threads/threadStore.ts:1759-1825`), and verbatim `firstUserIdx` preservation (`web-ui/lib/conversationCompaction.ts:698-726`) are shipped.                                                                                                                                      |
| **F9**   | #220          | **Closed & Sound**                                                      | `hasSubstantiveDeliverable` guards artifact+web exit (`roundLoop.ts:2291-2307`), `MAX_STREAMED_CONTENT_CHARS` is scoped per round/segment (`1194-1201, 2648`), unavailable host tools return structured errors (`2046-2073`), and empty synthesis stamps `incomplete` (`2495-2546`).                                                                                                                                                                                                                                               |
| **F10**  | #223          | **Closed & Sound**                                                      | `turnState.cumulativeOutputTokens` flows to final persist, SSE `done`, and abort persist (`roundLoop.ts:1124-1129, 2658-2661`, `chat/route.ts:406-409`); `LlamaCppProvider` extracts standalone `!choice` usage and `promptTokens` (`provider.ts:762-850`).                                                                                                                                                                                                                                                                        |
| **F11**  | #223          | **Closed & Sound**                                                      | `dispatchedRounds++` increments on every main round and synthesis pass (`roundLoop.ts:680, 1109, 2425, 2735-2740`).                                                                                                                                                                                                                                                                                                                                                                                                                |
| **F12**  | #223          | **Incomplete Closure** _(see `R11`)_                                    | `turnStartMs` is captured at `POST /api/chat` entry (`chat/route.ts:115, 482`), **but** `firstLlmRequestMs` is still stamped on first output chunk (`roundLoop.ts:1140, 1176, 1215`) rather than pre-dispatch (`1113`).                                                                                                                                                                                                                                                                                                            |
| **F13**  | #220          | **Closed & Sound**                                                      | `resolveChatTurnPriority` assigns `P1_BUILDER` to `board-drain` (`chat/route.ts:91-112`) and `onSettled` cleans up live registries on pre-start abort/rejection (`514-526, 543-549`).                                                                                                                                                                                                                                                                                                                                              |

### 1.2 Board Drain & Scheduler: Status Truthfulness and Pod-Restart Recovery

1. **Can a board item say `"working"` with no live turn?** **Yes, via three concrete paths (`R8`):**
   - When `boardControl.state` is `"stopped"` or `"paused"`, `BoardOrchestrator.drain()` breaks at `web-ui/lib/board/boardOrchestrator.ts:479-484` **before** `checkWorkingItemLiveness` (`509-748`), `SchedulerDaemon.tick()` skips `drain()` (`web-ui/lib/subagents/schedulerDaemon.ts:249`), and `mergeThreadsIntoBoard` skips linked threads (`web-ui/lib/board/mergeThreadsIntoBoard.ts:41-42`). Stopping a turn via `/api/threads/[id]` or restarting the pod while board control is `"stopped"`/`"paused"` leaves the item in `"working"` indefinitely.
   - `createProductionWorkingItemLivenessCheck` (`web-ui/lib/board/productionDrain.ts:80, 511`) only treats `"stopped" | "failed"` as interrupted; a non-live thread in `"paused"`, `"running"` (missed by `reconcileThread` at `threadStore.ts:679`), or `"needs_input"` returns `{ status: "live" }`, pinning the item at `"working"` and halting the queue.
   - `runPrOpenShadowStages` (`boardOrchestrator.ts:540-562`) and `runMergedShadowStage` (`825-844`) are unguarded by `try/catch`; an exception exits `drain()` with the item stuck in `"working"`.
2. **Can failure flags diverge from `status`?** **Yes, in both directions (`R8`):**
   - `BoardStore.update` (`web-ui/lib/board/boardStore.ts:333-347`) ignores `undefined` and only deletes `handoff` on `null`, so `needsAttention: true` and `parkedReason` survive transitions to `"queued"`, `"working"`, and `"done"` (`BoardView.tsx:165` renders `needs attention` on `DONE` cards; `selfDeployVerified.ts:224` reports them as exceptions).
   - Conversely, `boardOrchestrator.ts:846-861` sets `status: "needs-attention"` on post-run self-deploy failure **without** setting `needsAttention: true` or `parkedReason`, and `PATCH /api/board` (`web-ui/app/api/board/route.ts:42-55`) applies unvalidated status/flag combinations.
3. **Pod-restart mid-job recovery trace:**
   - **Before `onThreadCreated` (`productionDrain.ts:670-678`):** Item is still `"queued"` in `board.json` and re-runs cleanly on boot; the orphan thread file has `boardItemId` set so `inAppSupervisor` ignores it.
   - **Mid-turn after `onThreadCreated`:** When `boardControl.state === "running"`, `SchedulerDaemon.tick()` -> `BoardOrchestrator.drain()` -> `checkWorkingItemLiveness` reconciles the dead thread to `"stopped"` and requeues up to `MAX_ORPHAN_AUTO_RESUMES = 2` (`boardOrchestrator.ts:680-717`) with `hostAccess` preserved (`roundLoop.ts:449-451`), **except** `composeDispatcherBrief` (`dispatcher.ts:108-127`) drops `item.brief` (retaining only a 600-char slice in `openQuestions` at `boardOrchestrator.ts:694`), cutting off file allowlists and acceptance criteria.
   - **After PR/commit or `[[CHUNK_COMPLETE]]` before `board.json` write:** `[[CHUNK_COMPLETE]]` requeues without `item.brief` and without any retry cap; interrupted threads with commit/PR evidence park at `"needs-attention"` (`661-679`), except `inspectThreadPrOrCommitEvidence` (`productionDrain.ts:294`) checks `"host_create_pr"` instead of `"host_git_pr_create"` (`hostMode.ts:704`).
   - **Other runtimes on restart:** `SchedulerDaemon.checkStartupRecovery` (`schedulerDaemon.ts:184`) skips crash recovery if the pod restarts in `< 5 minutes` (`R10`), and SQLite-backed `project_tasks` / `runs` lose all state on ephemeral container disk (`R3`).

---

### 1.3 Track 1 Findings

#### `R1` — `PrioritySlotScheduler.releaseListeners` Merges Release and Reacquire Callbacks Into One `Set`, Breaking Queue Overlap and Draining All Pending Turns at Once

- **Severity:** `critical`
- **Status:** `REGRESSION` (introduced in PR #234: `d109005`, `3d581ae`, `3dd1fa7`)
- **Evidence (`file:line`):**
  - `web-ui/lib/slotScheduler.ts:121, 143-148, 180-185`:
    ```ts
    const listeners = this.releaseListeners.get(id) ?? new Set<() => void>();
    if (options.onWaitRelease) listeners.add(options.onWaitRelease);
    if (options.onWaitReacquire) listeners.add(options.onWaitReacquire);
    this.releaseListeners.set(id, listeners);
    ```
  - `web-ui/lib/slotScheduler.ts:307-330, 429-443`: `notifyWaitRelease(state.id)` (`308`) and `notifyWaitReacquire(state.id)` (`326`) both iterate `this.releaseListeners.get(id)`.
  - `web-ui/lib/chatTurnGate.ts:87-88`: wires `onWaitRelease: () => queue.beginOverlap()` and `onWaitReacquire: () => queue.endOverlap()`.
  - `web-ui/lib/jobQueue.ts:43-51, 113-135`: `beginOverlap()` increments `overlapDepth++` and invokes `activePump()`, where `pump()` (`129-131`) recursively calls `pump()` while `this.overlapDepth > 0`.
- **What Breaks or Costs:**
  1. When Turn A enters `lease.releaseForWait(executeToolBatches)`, `notifyWaitRelease` iterates the shared `Set` `[beginOverlap, endOverlap]`. `beginOverlap()` sets `overlapDepth = 1` and synchronously drains **every** pending job in `JobQueue.pending` (unbounded fan-out rather than overlapping 1 turn). Immediately afterward in the same loop, `endOverlap()` resets `overlapDepth` back to `0` before Turn A's tool batch starts, blocking any turn that arrives mid-wait.
  2. When Turn A finishes its tool batch and re-acquires the engine slot (`slotScheduler.ts:325`), `notifyWaitReacquire` iterates the same `Set` again — calling `beginOverlap()` **while Turn A is actively holding the engine slot** and launching newly queued turns concurrently.
  3. If `state.signal` aborts while Turn A is waiting in `acquireState(state)` (`slotScheduler.ts:325, 341, 385`), `acquireState` rejects before `notifyWaitReacquire` (`326`), leaking `overlapDepth > 0` (once the sets are split) and discarding any `caught` exception thrown inside `fn()` (`316-329`).
- **Concrete Fix Sketch:**
  - Replace `releaseListeners` in `web-ui/lib/slotScheduler.ts` with separate `waitReleaseListeners` and `waitReacquireListeners` maps, invoke `notifyWaitReacquire` inside a `try/finally` around `acquireState(state)` so abort still balances `endOverlap()`, and rethrow `caught` if `fn()` threw before an abort rejection.
  - In `web-ui/lib/jobQueue.ts:124-133`, track `inFlightCount` so `pump()` only launches while `inFlightCount < 1 + overlapDepth` (at most one overlapping turn per released waiter).
  - **Proving Test:** Extend `web-ui/tests/engineSlotReleaseDuringToolWait.test.ts` with 3+ queued turns, a mid-wait arrival, and an abort-during-wait case asserting `overlapDepth === 1` throughout the wait, `0` after reacquire/abort, and max 2 concurrent turns.

#### `R2` — `evaluateSettledThreadOutcome` Marks Deleted and Non-Terminal Threads as `"completed"` (`"done"`)

- **Severity:** `critical`
- **Status:** `INCOMPLETE CLOSURE` (Prior `F7`, PR #216 / PR #220)
- **Evidence (`file:line`):**
  - `web-ui/lib/board/productionDrain.ts:353-434, 681-693`
  - `web-ui/app/api/threads/[id]/route.ts:425-440` (`DELETE /api/threads/[id]`)
- **What Breaks or Costs:**
  - `defaultDispatchChatTurn` (`productionDrain.ts:553-565`) captures `response.ok === true` from the initial HTTP 200 SSE stream header. When `waitForTurnSettled` resolves, `productionDrain.ts:686` loads `settled = await threadStore.getThread(thread.id)` and calls `evaluateSettledThreadOutcome`.
  - Line `401` only checks `if ((response && !response.ok) || thread?.status === "failed" || thread?.status === "stopped")`. If the thread was deleted mid-run (`thread === null`) or settled in `"paused"`, `"active"`, `"running"`, or `"needs_input"`, execution falls through to lines `428-433`, returning `{ status: "completed", summary: "Completed thread <id>" }`. `BoardOrchestrator.drain()` (`boardOrchestrator.ts:863-867`) stamps the board item **`status: "done"`** with zero commits or PRs.
- **Concrete Fix Sketch:**
  - Fail closed in `web-ui/lib/board/productionDrain.ts:401`: require `Boolean(thread) && thread.status === "completed"` (after `chunk-complete` and `classifyJobSummary` checks); route `!thread` or any non-`"completed"` status to the `{ status: "failed" }` branch with an explicit reason (`"Thread missing at settlement"` / `"Unexpected thread status '<status>'"`).
  - **Proving Test:** Add unit cases in `web-ui/tests/boardDrainRecovery.test.ts` for `thread: null` and `thread.status: "paused" | "active"` with `response.ok: true`, asserting `status === "failed"`.

#### `R3` — Ephemeral Container Overlay Used for `runs.db` & `user_profile.json`, Plus Unreconciled `project_tasks` Crash Lock

- **Severity:** `critical`
- **Status:** `NEW`
- **Evidence (`file:line`):**
  - `deploy/k8s/web-ui.yaml:40-120` & `web-ui/Dockerfile:52-57` (PVC mounted at `/workspace`; `RUN_LEDGER_DB_PATH` and `USER_PROFILE_PATH` unset)
  - `web-ui/lib/ledger/runLedger.ts:78-83`, `web-ui/lib/flywheel/skillsStore.ts:44-49`, `web-ui/lib/memory/profile.ts:33-39` (default to `path.join(os.homedir(), ".local-agentic-sandbox", ...)`)
  - `web-ui/lib/projects/projectStore.ts:137-185, 344-394`, `web-ui/lib/projects/projectRunner.ts:68, 106-112, 149-174`
- **What Breaks or Costs:**
  - Every Kubernetes pod restart or self-deploy rollout wipes `/home/nextjs/.local-agentic-sandbox/runs.db` and `user_profile.json`, destroying all registered Projects, `project_tasks`, file review decisions, `RunLedger` history, candidate `FlywheelSkillsStore` entries, and deploy records.
  - Once persisted on the PVC, `project_tasks` still has zero startup crash reconciliation (`getSharedRunLedger()` only reconciles `runs`, never `project_tasks` or `projects.active_task_id`), so any crash during a running project task permanently blocks the project with HTTP 409 (`projectRunner.ts:106-112`).
- **Concrete Fix Sketch:**
  - Add `RUN_LEDGER_DB_PATH=/workspace/.agent/runs.db` and `USER_PROFILE_PATH=/workspace/.agent/settings/user_profile.json` to `deploy/k8s/web-ui.yaml` (and prefer `WORKSPACE_DIR/.agent` over `os.homedir()` in `runLedger.ts`, `skillsStore.ts`, and `profile.ts` when `WORKSPACE_DIR` exists).
  - Add startup reconciliation in `initProjectStore()` marking `'running'` rows without an in-memory `activeRunners` entry as `'parked'` and clearing `projects.active_task_id`.
  - **Proving Test:** Unit test in `web-ui/tests/projectOvernightRunner.test.ts` simulating a fresh store open over an orphaned `'running'` task and asserting `active_task_id` is cleared.

#### `R4` — Multi-Tool `assistant.tool_calls` <-> `role: "tool"` Invariants, Duplicate Synthesis Push, and Unguarded Barrier MCP Throws

- **Severity:** `high`
- **Status:** `NEW` / `REGRESSION` (exposed by PR #230 `parallel_tool_calls: true` and PR #229 `appendTrailingDirective`)
- **Evidence (`file:line`):**
  - `web-ui/lib/chat/roundLoop.ts:1520-1524, 1651-1705, 1725, 1774-1776, 1841-1855, 1875-1877, 1940-1974, 2078, 2102, 2203-2208, 2400-2404`
  - `web-ui/lib/microElision.ts:337-350, 493-533`
  - `web-ui/lib/llm/provider.ts:557, 859, 934-949`
  - `web-ui/lib/contextBudget.ts:650-679, 1214-1227` & `web-ui/lib/conversationCompaction.ts:691-726`
- **What Breaks or Costs:**
  1. **Missing `tool_call_id` corrupts Pass 2 micro-elision:** `roundLoop.ts:1651-1657` (and `1877, 1940, 1961, 2078, 2102`) pushes `role: "tool"` messages without `tool_call_id`. In `microElision.ts:347`, `findPairedCall` falls back to `m.tool_calls[0]` for **every** tool result in a parallel batch — so reading `[a.ts, b.ts]` in Round 1 and editing `a.ts` later falsely elides `b.ts`'s read output.
  2. **Mid-batch `role: "user"` injection breaks message adjacency:** `commitExecutedToolResult` (`roundLoop.ts:1665, 1674, 1701`) and `search_web` query revision (`1948`) call `appendTrailingDirective` (`role: "user"`) before remaining tool calls in the same round push their `role: "tool"` results, producing `assistant(tool_calls: [c0, c1]) -> tool(c0) -> user(directive) -> tool(c1)`.
  3. **Duplicate `assistant(tool_calls)` pushed before post-tool synthesis (`roundLoop.ts:2400`):** `currentAssistantMessage` (already pushed at `1524` with `tool_calls`) is pushed a second time at `2400` right before `{ role: "user", content: buildSynthesisDirective(...) }`, sending an unpaired `tool_calls` message into `runSynthesisPass`. Likewise, `searchBlocked` (`1775, 1973`), `skipped_abort` (`1725, 1875`), and single-message eviction splices (`contextBudget.ts:650, 1214`, `conversationCompaction.ts:691`) leave dangling `tool_calls`.
  4. **Barrier `target.client.callTool` lacks `try/catch` (`roundLoop.ts:2204`):** Unlike parallel reads (`1842-1854`), an MCP timeout or transport error on `workspace_run_command` / `workspace_write_file` / `search_web` throws uncaught and aborts the entire turn.
  5. **Chunk-arrival ordering in `provider.ts:934`:** `Array.from(toolCallsAccumulator.values())` emits multi-index tool calls in arrival order rather than sorting by `tc.index`.
- **Concrete Fix Sketch:**
  - Attach `tool_call_id: toolCall.id` to all `role: "tool"` pushes in `roundLoop.ts`, emit synthetic skipped `role: "tool"` stubs when abort/`searchBlocked` halts a batch early, buffer mid-batch trailing directives until all `role: "tool"` messages for the round are pushed, and delete the duplicate `conversationMessages.push(currentAssistantMessage)` at `roundLoop.ts:2400`.
  - Wrap `target.client.callTool` (`roundLoop.ts:2203-2208`) in `try/catch`, sort `toolCallsAccumulator` by numeric index in `provider.ts:934`, track `toolOffset` in `microElision.ts:347`, and evict `assistant.tool_calls` + `role: "tool"` groups atomically in `contextBudget.ts` / `conversationCompaction.ts`.
  - **Proving Test:** Multi-tool tests in `web-ui/tests/roundToolFanout.test.ts`, `microElision.test.ts`, and `llmProvider.test.ts` pinning `tool_call_id` pairing, post-batch directive ordering, synthesis message structure, and barrier MCP error recovery.

#### `R5` — `JobQueue` Overlap Permits Concurrent Execution on the Same `threadId`, Shared `/workspace`, and Shared `HOST_CHECKOUT_PATH`

- **Severity:** `high`
- **Status:** `REGRESSION` (PR #234: `3d581ae`, `3dd1fa7`)
- **Evidence (`file:line`):**
  - `web-ui/lib/chatTurnGate.ts:46-105`, `web-ui/lib/jobQueue.ts:24, 96, 104-106`
  - `web-ui/app/api/chat/route.ts:243-246, 421, 492-502, 532`
  - `web-ui/lib/chat/roundLoop.ts:2235-2236, 2871-2877`
- **What Breaks or Costs:**
  - Two turns queued for the **same `threadId`** can now overlap while Turn A is in `releaseForWait`: Turn B overwrites `activeTurnAbortControllers` (`route.ts:421`) and `turnSettledPromises` (`532`), races on `<threadId>.json`, and whichever turn finishes first deletes `activeExecutionSet` and `activeTurnRegistry` in `finally` (`roundLoop.ts:2871-2877`) while the sibling turn is still live.
  - Because `route.ts:496` sets `worktree = null`, overlapping an interactive host/workspace turn with a board job mutates the same `/workspace` or `HOST_CHECKOUT_PATH` while Turn A is mid-`npm install` or mid-`git` operation. Also, `JobQueue.running` (`jobQueue.ts:96, 104-106`) is a single scalar overwritten by Turn B and cleared to `null` when Turn B finishes first.
- **Concrete Fix Sketch:**
  - Prevent `JobQueue.pump()` from overlapping any pending job whose `threadId` is already in an `activeJobs` set (replacing scalar `this.running`), and restrict `releaseForWait` queue overlap when both turns share an unisolated workspace/host checkout (or gate overlap on read-only batches / isolated worktrees).
  - **Proving Test:** Test in `web-ui/tests/engineSlotReleaseDuringToolWait.test.ts` verifying same-`threadId` turns serialize strictly and `snapshot().running` stays populated until all active turns finish.

#### `R6` — Path-Confinement Bypass in `GET /api/files`, Unvalidated `[id]` Traversal in Thread/Skill Stores, and Missing Deploy/Diff Parameter Guards

- **Severity:** `high`
- **Status:** `NEW`
- **Evidence (`file:line`):**
  - `web-ui/app/api/files/route.ts:120-187` (`path.resolve(cwd, "..")` at `:127` with `WORKDIR /app` in `web-ui/Dockerfile:50` resolves to `"/"`)
  - `web-ui/lib/threads/threadStore.ts:301-307`, `web-ui/app/api/threads/[id]/route.ts:229, 265, 427`, `web-ui/lib/subagents/skillGate.ts:134-136`
  - `web-ui/app/api/projects/browse/route.ts:55-61, 133-139`
  - `web-ui/app/api/deploy/route.ts:45-57, 122-206`, `web-ui/lib/deploy/selfDeploy.ts:250, 280-281, 309, 440`, `web-ui/lib/projects/projectGit.ts:222, 306`
- **What Breaks or Costs:**
  1. In production (`cwd === "/app"`), `candidateRoots` in `GET /api/files` includes `"/"`, allowing arbitrary reads of any container file matching `ALLOWED_FILE_EXTENSIONS` (`.json`, `.yaml`, `.ts`, `.md`, `.log`, `.sql`, `.toml`, etc.).
  2. `ThreadStore.getFilePath(id)` and `skillGate.ts:135` concatenate unvalidated IDs into paths: URL-encoded `..%2F` in `/api/threads/[id]` (`GET`/`DELETE`) or `id: "../../..."` in `POST /api/skills` reads, deletes, or writes `.json`/`.md` files outside `threadsDir` / `skillsDir` (e.g., deleting `/workspace/.agent/board/board.json`).
  3. `api/projects/browse` checks `.startsWith(rootNorm)` without a trailing `path.sep` or `fs.realpathSync` (sibling-prefix and symlink escape).
  4. `POST /api/deploy` omits `isSameOriginRequest` on `executeSelfDeploy`/`deployBuild` and passes unvalidated `branchName` (no `--` before git ref), `hostAddress` (SSRF in `http://${hostAddress}:3001`), and `imageTag`; `projectGit.ts:222, 306` passes unvalidated `baseSha` to `git diff` / `git checkout`.
- **Concrete Fix Sketch:**
  - Remove `cwd` and `path.resolve(cwd, "..")` from `candidateRoots` in `api/files/route.ts` and enforce `confinePathToRoot` + `fs.realpathSync` in both `api/files` and `api/projects/browse`.
  - Validate `threadId` and `candidateId` against `/^[A-Za-z0-9._-]+$/` (rejecting `..`, `/`, `\`).
  - Enforce `isSameOriginRequest` across all `POST /api/deploy` branches and validate `branchName`, `imageTag`, `hostAddress`, and `baseSha` against strict allowlists with `--` ref separators.
  - **Proving Test:** Security regression suite testing `/api/files?path=/etc/...`, `/api/threads/..%2Fboard%2Fboard`, `/api/projects/browse`, and `/api/deploy` input rejection (`400`/`403`).

#### `R7` — `board.meta.json` Migration Overwrites `control.state`, Unsynchronized Manual vs Daemon Drain, and Stale Read-Modify-Write Store Races

- **Severity:** `high`
- **Status:** `NEW`
- **Evidence (`file:line`):**
  - `web-ui/lib/board/boardStore.ts:183, 187-231, 243-248` vs `web-ui/lib/board/boardControlStore.ts:95, 120-130`
  - `web-ui/app/api/board/drain/route.ts:63-70` vs `web-ui/lib/subagents/schedulerDaemon.ts:8, 249-266` (`productionDrain.ts:657`)
  - `web-ui/lib/subagents/scheduler.ts:327, 436, 451, 469`
  - `web-ui/app/api/threads/[id]/route.ts:266, 290, 312, 391-415`
- **What Breaks or Costs:**
  1. Both `BoardStore` and `BoardControlStore` write `board.meta.json`. When `BoardControlStore.writeControl` creates `board.meta.json` (`{ control }`) without `version`, the next `new BoardStore()` runs `migrateIfNeeded()` (`boardStore.ts:226-230`) and overwrites `board.meta.json` with `{ version: 2 }`, silently resetting board control to `"stopped"`.
  2. `POST /api/board/drain` does not share `schedulerDaemon.ts`'s `boardDrainInFlight` guard; during the up-to-30s `verifyHostCheckoutGrounding` window (`productionDrain.ts:657`) before `onThreadCreated`, concurrent daemon + manual drains pick the same head `"queued"` item and spawn duplicate job threads.
  3. `UnattendedScheduler.executeScheduledRun` (`scheduler.ts:327, 436`) and `POST /api/threads/[id]` (`route.ts:266, 290, 312`) write back stale pre-await snapshots of `schedules.json` and `<threadId>.json`, erasing concurrent edits or streaming `roundLoop` messages; `BoardStore.writeAll`, `BoardControlStore.writeControl`, and `touchActiveTurn` use non-atomic `fs.writeFileSync`.
- **Concrete Fix Sketch:**
  - Preserve existing keys in `BoardStore.migrateIfNeeded` (`{ ...existing, version: BOARD_STORE_VERSION }`) and switch all JSON stores to atomic temp-file + `renameSync` writes.
  - Share a `globalThis.__boardDrainInFlight` mutex between `SchedulerDaemon` and `POST /api/board/drain`.
  - Re-read `schedules.json` / `<threadId>.json` immediately prior to mutating target fields under per-file in-process locks.
  - **Proving Test:** Store tests proving `new BoardStore()` preserves `board.meta.json` `control.state`, concurrent `POST /api/board/drain` calls deduplicate, and `executeScheduledRun` preserves mid-run schedule edits.

#### `R8` — Board Status Untruthfulness (`working` Stuck When Paused/Stopped, Unclearable `needsAttention` Flags) and Context-Dropping Handoff / Chunk Recovery

- **Severity:** `high`
- **Status:** `INCOMPLETE CLOSURE` (Prior `F1`, `F3`, PR #216 / PR #214)
- **Evidence (`file:line`):**
  - `web-ui/lib/board/boardOrchestrator.ts:479-484, 540-617, 679-704, 734, 825-897`
  - `web-ui/lib/board/boardStore.ts:318-352`, `web-ui/app/api/board/route.ts:42-55`
  - `web-ui/lib/board/dispatcher.ts:108-127`, `web-ui/lib/board/productionDrain.ts:80, 105-144, 294, 511`
  - `web-ui/lib/chat/roundLoop.ts:734-740`, `web-ui/lib/threads/threadStore.ts:679`
- **What Breaks or Costs:**
  - Items remain stuck in `status: "working"` with no live turn whenever `boardControl` is `"stopped"`/`"paused"` (`drain()` exits at `479-484` before liveness reconciliation), when non-live threads have status `"paused"`/`"running"`/`"needs_input"`, or when shadow stages throw (`540-562, 825-844`).
  - `BoardStore.update` (`333-347`) cannot clear `needsAttention` or `parkedReason` (`DONE` cards keep failure badges), `boardOrchestrator.ts:846-861` sets `status: "needs-attention"` without `needsAttention: true` or `parkedReason`, `PATCH /api/board` accepts unvalidated statuses, and `updateItem` drops `evidence` (`prNumber`, `mergeSha`).
  - When `item.handoff` is set (orphan auto-resume or `chunk-complete`), `composeDispatcherBrief` (`dispatcher.ts:108-127`) omits `item.brief` completely (orphan resume keeps only 600 chars in `openQuestions`), `chunkWorkspaceRoot` (`roundLoop.ts:734-740`) writes runlogs to ephemeral `/app` with `"HEAD"`/`"unknown"` git metadata, `chunk-complete` requeues have no retry cap, and `inspectThreadPrOrCommitEvidence` (`productionDrain.ts:294`) checks `"host_create_pr"` instead of `"host_git_pr_create"`.
- **Concrete Fix Sketch:**
  - Run non-issuing liveness reconciliation (`checkWorkingItemLiveness` to settle/park dead `"working"` items without starting new jobs) even when `boardControl` is `"paused"`/`"stopped"`, include `"running"` in `reconcileThread` (`threadStore.ts:679`), treat `"paused"`/`"needs_input"` non-live threads as interrupted, and wrap shadow stages in `try/catch`.
  - Support `null` field deletion for `needsAttention`, `parkedReason`, and `autoResumeCount` in `BoardStore.update`, clear them on transitions to `"working"`/`"done"`/`"queued"`, validate `PATCH /api/board`, and persist `evidence`.
  - Always include full `item.brief` in `composeDispatcherBrief`, write `chunkRunlogPath` under PVC `AGENT_CHECKPOINT_DIR` when `_worktree` is null, cap chunk requeues, and match `"host_git_pr_create"` + `"git_commit"` in `productionDrain.ts:294`.
  - **Proving Test:** Tests in `boardOrchestrator.test.ts` and `boardDrainRecovery.test.ts` covering paused-control dead-turn reconciliation, `needsAttention` clearing on `"done"`, full brief retention across handoff, and `host_git_pr_create` detection.

#### `R9` — Mid-Round Thinking Loss on Abort/Error, Token-1 Snapshot Suppression of Round-End `thought` SSE, and `tool_choice: "none"` / Synthetic User-Directive Edge Defects

- **Severity:** `high`
- **Status:** `REGRESSION` (PR #232 `ad403ae` & PR #229 `801afb7`)
- **Evidence (`file:line`):**
  - `web-ui/lib/chat/roundLoop.ts:898-916, 1086-1091, 1098, 1154-1172, 1257-1274, 1392, 2488-2540, 2842`
  - `web-ui/app/api/chat/route.ts:387-427`, `web-ui/lib/chat/turnEngine.ts:477, 483-557`
  - `web-ui/lib/contextBudget.ts:345-367, 636-643, 1199-1209`, `web-ui/lib/conversationCompaction.ts:532-534`
- **What Breaks or Costs:**
  1. **Suppressed round-boundary `thought` SSE:** On Round 0 (`lastWriteMs = -Infinity`) and after any `>= 5s` prefill/tool wait, the very first thinking token flushes `streamSnapshot.maybeWrite` (`roundLoop.ts:1154`), sets `thoughtEventThisRound = true` (`1166`), and emits `{ type: "thought", thought: <1 token> }`. At round end (`1266`), `!thoughtEventThisRound` is `false`, suppressing the complete `thought` + `thinkingSegments` event.
  2. **Thinking lost on mid-round abort/error:** `roundThinking` (`roundLoop.ts:1098`) and `passThinking` (`turnEngine.ts:477`) are only appended to `turnState.accumulatedThoughts` after stream completion; mid-round abort (`chat/route.ts:401`) or stream error (`roundLoop.ts:2842`) overwrites the snapshot message without the active round's reasoning.
  3. **Ignored `tool_choice: "none"` & synthetic `role: "user"` directives:** If an engine ignores `tool_choice: "none"`, `runSynthesisPass` (`turnEngine.ts:483-547`) drops `toolCallProgress` (risking 180s inactivity timeout) and retries identical messages on markup failure (`roundLoop.ts:2500-2515`), while `isFinalRound` (`roundLoop.ts:1392`) lacks `if (isFinalRound)` protection and still executes emitted tools. Meanwhile, `appendTrailingDirective` pushes `{ role: "user" }` messages (`contextBudget.ts:362`) that `fitContextWindow` (`636-643`) mistakes for `latestUserIdx` (evicting real prior user prompts), `summarizeTurnHistory` (`conversationCompaction.ts:532-534`) records as user goals, and `roundLoop.ts:898-916` slices `inFlightTail` after.
- **Concrete Fix Sketch:**
  - Emit `{ type: "thought", thought, thinkingSegments }` unconditionally once at round completion (`roundLoop.ts:1266-1273`), removing the mid-round `1165-1172` emission; mirror `inFlightThinking` onto `turnState` so abort/error persistence preserves partial reasoning.
  - Guard `if (isFinalRound)` at `roundLoop.ts:1392`, arm `passDeadline` on `toolCallProgress` and append a plain-prose correction directive before synthesis pass 2 (`turnEngine.ts:493-547`, `roundLoop.ts:2500-2515`), and tag synthetic directives (`isDirective: true`) so compaction/eviction helpers distinguish them from user prompts.
  - **Proving Test:** Assertions in `thoughtStreamDeltaOnly.test.ts` (round-end `thought` payload equals full reasoning after token-1 snapshot flush; abort preserves partial thinking) and `synthesisRetry.test.ts`.

#### `R10` — `SchedulerDaemon` Skips Crash Recovery on `< 5m` Restarts and `sweepStalledThreads` Reconciles Before Supervising `taskId` Threads

- **Severity:** `medium`
- **Status:** `NEW` & `INCOMPLETE CLOSURE` (Prior `F2` non-board `taskId` path)
- **Evidence (`file:line`):**
  - `web-ui/lib/subagents/schedulerDaemon.ts:180-208`, `web-ui/lib/subagents/scheduler.ts:277-321`
  - `web-ui/lib/threads/threadStore.ts:607, 679-733, 1149`, `web-ui/lib/chat/roundLoop.ts:582-600`
- **What Breaks or Costs:**
  - Kubernetes pod restarts typically complete in `10–60s` (`< 300_000ms`), causing `SchedulerDaemon.checkStartupRecovery()` (`schedulerDaemon.ts:185`) to skip `checkCrashAndRecover()` and leave interrupted cron manifests `"active"`.
  - For non-board `taskId` threads, `sweepStalledThreads` (`threadStore.ts:607`) calls `this.getThread(s.id)` (which runs `reconcileThread` and flips `"active"` -> `"stopped"` after a restart) before `superviseStalledThread`, preventing post-restart auto-resume; `roundLoop.ts:582-600` also exits early on invalid `approvalContinuationId` without persisting an error message.
- **Concrete Fix Sketch:**
  - Run `checkCrashAndRecover()` unconditionally on fresh daemon startup whenever `.scheduler-heartbeat` has `active: true` and mark orphaned cron manifests `"crashed"`; read raw thread JSON before `reconcileThread` for `taskId` candidates in `sweepStalledThreads`; persist an error message before returning at `roundLoop.ts:588-599`.
  - **Proving Test:** Startup recovery unit test in `schedulerDaemon` with a 15s restart gap and post-restart `taskId` sweep test in `threadStoreCheapSweep.test.ts`.

#### `R11` — `firstLlmRequestMs` Still Includes Round-0 LLM Prefill / TTFT in `phaseTimings.contextPrepMs`

- **Severity:** `medium`
- **Status:** `INCOMPLETE CLOSURE` (Prior `F12`, PR #223)
- **Evidence (`file:line`):** `web-ui/lib/chat/roundLoop.ts:322, 1113, 1140, 1176, 1215, 2714-2715`
- **What Breaks or Costs:** `firstLlmRequestMs` is stamped inside the `for await` loop on the first thinking/content/tool chunk (`1140, 1176, 1215`) rather than before `streamLlmChat` (`1113`), inflating `contextPrepMs` by `15–53s` of engine prompt prefill.
- **Concrete Fix Sketch:** Set `if (firstLlmRequestMs === null) firstLlmRequestMs = Date.now();` immediately above `for await (const chunk of streamLlmChat(...))` at `roundLoop.ts:1113` and pin in `countingTruth.test.ts`.

#### `R12` — Residual Unbounded Timeouts (`bankGitWork`, MCP Connect), Unguarded `req.json()` HTTP 500s, Stale Triage `head`, and `testGate` Mapping Drift

- **Severity:** `low`
- **Status:** `NEW` / `RESIDUAL`
- **Evidence (`file:line`):**
  - `web-ui/lib/jobChunking.ts:105, 222` (sync `git push` without `timeout` when `runChunkedJobLoop` runs with default `bankGit = true`), `web-ui/lib/chat/mcpClients.ts:41` (`client.connect` without timeout), `web-ui/lib/chat/roundLoop.ts:2263` (omits `threadsDir`)
  - `web-ui/lib/board/boardOrchestrator.ts:781-790` (triage retry uses pre-turn `head` snapshot)
  - `web-ui/app/api/board/intake/route.ts:33`, `deploy/route.ts:42`, `settings/host/route.ts:30`, `settings/memory/route.ts:22`, `settings/notifications/route.ts:21`, `skills/route.ts:52`, `tasks/route.ts:35`, `schedules/route.ts:24`, `threads/route.ts:43`, `threads/[id]/route.ts:271`, `projects/browse/route.ts:125` (malformed JSON returns HTTP `500`)
  - `web-ui/lib/testGate.ts:784, 1075-1108, 1636` & `web-ui/lib/chat/roundLoop.ts:1-2899`
- **What Breaks or Costs:** Stalled git/MCP operations can hang callers; malformed request bodies return 500s; `roundLoop.ts` changes do not trigger four chat honesty/budget suites mapped only to `app/api/chat/route` (`testGate.ts:1075-1108`); `roundLoop.ts` is 2,899 lines (vs ~600-line guideline in `docs/coding-standard.md:30-31`).
- **Concrete Fix Sketch:** Add explicit timeouts to `bankGitWork` and `connectMcpClient`, reload `store.get(head.id)` before triage retry, parse JSON bodies via a 400 helper, add `lib/chat/roundLoop` to `testGate.ts:1075` while removing dead patterns (`784, 1636`), and schedule modular extraction from `roundLoop.ts`.

---

## Section 2 — Track 2: Performance Audit

### 2.1 Code Verification of Shipped Performance Program (`P0–P6` / Sinks `#1–#8`)

| Item & PR                       | Claimed Mechanism                                                                                                          | Verdict at `b64022ac`                                         | Quantified Code Proof (`file:line`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** (PR #227, Sink #1)       | Defer in-place micro-elision below 70% budget watermark (`+10K` rearm floor)                                               | **Verified Sound** _(expected `>70K` sweep cost)_             | `web-ui/lib/microElision.ts:40, 47, 94-124`, `web-ui/lib/chat/roundLoop.ts:802-820`. Zero early-message mutations occur below `70,000` effective tokens (`0.7 * 100,000`). Above `70K`, Pass 1–3 (`microElision.ts:378-570`) rewrites messages back to Round 1, resetting reuse to `R = 2,734` once per `+10,000`-token growth window.                                                                                                                                                                                                                                           |
| **P1** (PR #229, Sink #3)       | Keep `tools: roundTools` + `tool_choice: "none"` on final/synthesis rounds; `appendTrailingDirective`; static `roundTools` | **Substantially Sound** _(1 synthesis bug in `R4`)_           | `roundLoop.ts:780-781, 1086-1091`, `web-ui/lib/chat/turnEngine.ts:482-493`, `web-ui/lib/llm/provider.ts:448-570, 611-621`, `web-ui/lib/progressiveTools.ts:370-392`. `mergeSystemDirective` has **0** production callers; `describe_tool` returns schemas in `role: "tool"` without mutating `roundTools`; `normalizeOpenAIMessages` leaves prior messages untouched. _(Defect: `roundLoop.ts:2400` duplicates `currentAssistantMessage` before synthesis — see `R4`.)_                                                                                                          |
| **P2** (PR #219, #230, Sink #2) | `parallel_tool_calls: true`, multi-index `delta.tool_calls`, `TOOL_FANOUT_CAP = 8` read batching                           | **Verified Sound** _(on `LlamaCppProvider`)_                  | `provider.ts:617, 853-889, 933-957`, `web-ui/lib/chat/toolFanout.ts:10, 24-37, 55-107`, `roundLoop.ts:1708-1899`. Across all **37** registered tools, **12** read-only tools (`host_read_file`, `host_list_dir`, `host_git_status`, `host_git_pr_status`, `workspace_read_file`, `workspace_get_tree`, `workspace_grep`, `git_status`, `git_diff`, `verify_container_provenance`, `docker_scout_policy_gate`, `describe_tool`) fan out up to 8-wide; **25** mutating/web-budgeted tools act as barriers (`OllamaProvider` at `provider.ts:137-143` omits `parallel_tool_calls`). |
| **P3** (PR #232, Sink #7)       | Stream per-token `thinking` deltas only; `<= 1` cumulative `thought` event per round                                       | **Partially Bypassed** _(see `P-F6`, `R9`, `U-F3`)_           | Per-token SSE `thought` events are eliminated (`roundLoop.ts:1164-1172`, `turnEngine.ts:508-524`), saving ~3.9 GB of SSE JSON. **However**, `roundLoop.ts:1147-1159, 1202-1211`, `turnEngine.ts:510-518, 538-545`, and `streamSnapshot.ts:99-106` still eagerly join/trim/clone cumulative thoughts on **every** thinking and content token _before_ checking the 5s timer at `streamSnapshot.ts:111`.                                                                                                                                                                           |
| **P4** (PR #233, Sink #6)       | `STREAM_SNAPSHOT_INTERVAL_MS = 5000` + suppress 1.5s thread poll while SSE delivers                                        | **Bypassed in Prefill & Tool Waits** _(see `P-F1`, `P-F3`)_   | `streamSnapshot.ts:20` is `5000`, **but** `roundLoop.ts:2246-2261` forces a full write (`{ force: true }`) every round followed immediately by `touchActiveTurn` (`2263`), and `web-ui/app/page.tsx:528-555` resumes 1.5s full-thread polling `1,500 ms` into every LLM prefill and tool wait.                                                                                                                                                                                                                                                                                   |
| **P5** (PR #234, Sinks #4 & #5) | Default mid-turn compaction to extraction digest + `lease.releaseForWait()` during tool batches                            | **Compaction Sound; Overlap Broken** _(see `R1`, `P-F7`)_     | `resolveMidTurnHybridEnabled()` (`conversationCompaction.ts:127-132`) defaults `false`, keeping mid-turn compaction synchronous and preserving `R_base ~ 2,734` (`roundLoop.ts:857-927`; note turn-start compaction at `507-533` still runs hybrid if `COMPACTION_STRATEGY=hybrid`). `releaseForWait` (`2235-2239`) is broken by `R1` and risks `R = 0` single-slot cache eviction on `1–5s` waits (`P-F7`).                                                                                                                                                                     |
| **P6** (PR #235, Sink #8)       | Measure prompt estimate once per round + dirty-flag invalidation at every mutation rung                                    | **Incomplete Closure — Unwired in Production** _(see `P-F2`)_ | `markDirty()` invalidates all 4 rungs inside `fitConversationToBudget` (`contextBudget.ts:1165, 1183, 1224, 1265`), **but `precomputedRawMessageTokens` is never passed in `roundLoop.ts` or `turnEngine.ts:485`** (only in standalone `runChatToolLoop`, which itself has stale cache bugs at `829, 854, 857`). Production rounds still execute **7–10+ full-history scans/round**.                                                                                                                                                                                             |

---

### 2.2 Track 2 Findings (Quantified Remaining Sinks)

#### `P-F1` — `touchActiveTurn` Synchronous Multi-MB Full-Thread Rewrite, Round-End Double Write, and Duplicate Client Turn-End `addMessage` Upload

- **Severity:** `critical`
- **Status:** `NEW` (undermines `P4` / Sink `#6` on the 1-vCPU pod)
- **Evidence (`file:line`):**
  - `web-ui/lib/threads/threadStore.ts:86-95` (`touchActiveTurn`), `998-1007` (`listThreadSummaries` mtime cache), `1210-1259` (`saveThread`), `1327-1393` (`addMessage`)
  - `web-ui/lib/chat/roundLoop.ts:343` (30s heartbeat timer), `1727` (post-read-batch), `2227` (post-barrier), `2246-2263` (round boundary), `2742` (final persist)
  - `web-ui/components/ChatStream.tsx:1258-1293` (client `POST /api/threads/${effectiveThreadId}` `{ action: "addMessage" }` on SSE `done`)
- **What Breaks or Costs (Quantified):**
  1. `touchActiveTurn` (`threadStore.ts:88-94`) synchronously executes `JSON.parse(fs.readFileSync(filePath, "utf8"))` + `fs.writeFileSync(filePath, JSON.stringify(raw, null, 2))` on the 1-vCPU (`cpu: "1000m"`) event loop. On a `1.6–5.0 MB` thread JSON (`97–300` rounds), each call blocks the event loop for `25–90 ms` and mutates `mtimeMs`, invalidating `.summaries-index.json` (`threadStore.ts:998-1007`) so the next `/api/board` or `/api/threads` call must re-read and re-parse the full file too.
  2. At every round end (`roundLoop.ts:2246-2263`), `streamSnapshot.maybeWrite(..., { force: true })` runs a full `saveThread` (`readFileSync` + `JSON.parse` + `computeThreadTokenEconomics` + pretty `JSON.stringify` + `writeFileSync` + `renameSync`) **and line `2263` immediately calls `touchActiveTurn(activeThreadId)`, synchronously reading, parsing, and writing the exact same multi-MB file a second time**! Across a 97-round `1.6 MB` job (`23js`/`p2yx`), round boundaries + tool heartbeats + 30s ticks still perform **`~320–450` synchronous full-file serializations (`~500 MB–1.4 GB` of synchronous disk I/O)**.
  3. At turn settlement, `roundLoop.ts:2742` writes the final message, and `ChatStream.tsx:1260` immediately uploads the entire assistant message + `traces` + `diffs` back to `POST /api/threads/[id]` (`addMessage`), causing another multi-MB read/parse/write and overwriting server `durationMs` / `content` with client-parsed copies.
- **Concrete Fix Sketch:**
  - Make `touchActiveTurn` update an in-memory `lastActivityAtMs` map in `activeTurnRegistry` (already consulted by `computeTurnLiveness` at `threadStore.ts:72-80`) or touch `fs.utimesSync(filePath, now, now)` / a 32-byte `.heartbeat` sidecar — zero JSON parsing or multi-MB rewriting.
  - Delete `touchActiveTurn` at `roundLoop.ts:2263` (redundant right after `maybeWrite`), allow fast `< 5s` rounds to respect `STREAM_SNAPSHOT_INTERVAL_MS` instead of `{ force: true }` on every round boundary (flushing on `5s` cadence + turn settlement), and remove the redundant `addMessage` POST in `ChatStream.tsx:1258-1293` when the turn ran through `/api/chat`.
  - **Proving Test:** Spy on `fs.writeFileSync` during a 10-round mocked `runChatTurn` and assert `0` full-thread writes from `touchActiveTurn` and `0` duplicate round-end writes.

#### `P-F2` — `P6` Estimate Cache Never Wired Into Production `roundLoop.ts` or `turnEngine.ts` (7–10+ Full-History Scans per Round)

- **Severity:** `high`
- **Status:** `INCOMPLETE CLOSURE` (PR #235 / Sink `#8`)
- **Evidence (`file:line`):**
  - `web-ui/lib/chat/roundLoop.ts:782, 797, 814, 822, 825, 833, 984, 993, 1075, 1094, 1095, 1429, 2349`
  - `web-ui/lib/chat/turnEngine.ts:485` (`fitContextWindow` called without `precomputedRawMessageTokens`)
  - `web-ui/lib/contextBudget.ts:650, 684, 704, 817-868`
  - `web-ui/tests/estimateScanPerRound.test.ts:68` (tests `runChatToolLoop`, never `runChatTurn`)
- **What Breaks or Costs (Quantified):**
  - Every normal append-only round in `roundLoop.ts` still runs **7 full-history `estimateTokens` (`JSON.stringify`) scans** (`797`, `822`, `833 -> contextBudget.ts:1113`, `984`, `993`, `1075 -> contextBudget.ts:572`, `1094`) plus **3 `JSON.stringify(roundTools)` schema scans** (`782`, `contextBudget.ts:591`, `1095`). Notice lines `797` & `822` and lines `984` & `993` scan the exact same unmutated `conversationMessages` array back-to-back!
  - Batch-elision rounds run **9** scans (`+814, +825`); compaction rounds run **10+**; synthesis runs **2+** (`2349`, `turnEngine.ts:485`). Across a 100-round job at ~200–400 KB history, this burns **700–1,000 full-array serializations (~200–400 MB string churn)** on the 1-vCPU event loop.
  - Inside `runChatToolLoop` (`contextBudget.ts:829, 854, 857`), `appendTrailingDirective` mutates `conversationMessages` without updating `rawRoundTokens` / `contextTokens`, feeding stale `precomputedRawMessageTokens` into `fitContextWindow` (`867`).
- **Concrete Fix Sketch:**
  - Create a round-scoped `{ rawTokens, dirty }` tracker in `roundLoop.ts:790-1096` (and precompute `roundToolSchemaTokens` once per turn at `782` since `roundTools` is constant), mark `dirty = true` on `roundElision.stubbed > 0`, `compaction.compacted`, `appendTrailingDirective`, and `consumeSteers`, thread `precomputedRawMessageTokens` into `estimateEffectivePromptTokens`, `fitConversationToBudget`, `fitContextWindow`, `runSynthesisPass`, and reuse `fitted.estimatedTokens` (`contextBudget.ts:622, 735`) at `roundLoop.ts:1094`. Fix `contextBudget.ts:829, 854, 857` to mark dirty as well.
  - **Proving Test:** Add a `runChatTurn` test in `web-ui/tests/estimateScanPerRound.test.ts` asserting `<= 1` raw `conversationMessages` scan per append-only round and `0` per-round `estimateToolSchemaTokens` re-stringifies.

#### `P-F3` — `P4` Poll Suppression Wakes Up `1.5s` Into Every LLM Prefill & Tool Wait, Plus Unbounded Multi-MB Observed Polling and Double Thread Loads

- **Severity:** `high`
- **Status:** `INCOMPLETE CLOSURE` (PR #233 / Sink `#6` & open `U4`)
- **Evidence (`file:line`):**
  - `web-ui/app/page.tsx:485, 520-530, 545-566, 647-684` & `web-ui/lib/streamPollGate.ts:17, 24-40`
  - `web-ui/components/ChatStream.tsx:438-454`
  - `web-ui/app/api/threads/[id]/route.ts:226-260`
- **What Breaks or Costs (Quantified):**
  1. `page.tsx:528-530` only updates `lastStreamChunkAtRef` when `[messages]` changes, and `STREAM_POLL_QUIET_WINDOW_MS` is `1500` (`streamPollGate.ts:17`). During every `10–53s` LLM prefill and every `5–60s` tool execution batch, `messages` does not change — so after `1.5s`, `isSseStreamDelivering` returns `false` and the client polls `GET /api/threads/[id]` every `1,500 ms` (`12–34` full multi-MB disk reads + JSON parses + HTTP transfers per prefill/tool wait while SSE is already open!).
  2. On observed board turns (mobile's primary monitoring workflow), `GET /api/threads/[id]` has no `ETag` / `304` or lightweight delta mode, transferring and parsing the full `1.6–5.0 MB` thread JSON (`1.1–3.3 MB/s`) every `1.5s` while `page.tsx:662` also polls `/api/tasks?threadId=...` every `2.0s`.
  3. Selecting any thread triggers **two** simultaneous `GET /api/threads/${id}` requests (`page.tsx:485` and `ChatStream.tsx:444`).
- **Concrete Fix Sketch:**
  - Gate `shouldPollLiveThread` on an explicit `isLocalSseOpen` boolean lifted from `ChatStream` (suppressing polling for the entire duration of a healthy open SSE response, including prefill and tool batches, since `turnEngine.ts:134` sends SSE `ping` every 10s).
  - Add `ETag` (`"${thread.updatedAt}-${thread.messages.length}"`) -> `304 Not Modified` and `?omitHeavyTraceResults=1` / delta support on `GET /api/threads/[id]`, and remove the duplicate fetch in `ChatStream.tsx:438-454`.
  - **Proving Test:** Unit test in `streamPollGate.test.ts` verifying `shouldPollLiveThread` stays `false` across a 45s prefill while `isLocalSseOpen === true`, plus route test for `If-None-Match` -> `304`.

#### `P-F4` — Sidebar Thread Search (`150ms` Debounce) Synchronously Reads and `JSON.parse`s Every Thread File on Disk Per Keystroke

- **Severity:** `high`
- **Status:** `OPEN PRIOR` (`U4` server impact quantified)
- **Evidence (`file:line`):**
  - `web-ui/components/ThreadsSidebar.tsx:50-73` (`150ms` debounce -> `GET /api/threads?q=...`)
  - `web-ui/lib/threads/threadStore.ts:1086-1130` (`listThreadSummaries(query)`)
- **What Breaks or Costs (Quantified):**
  - For every non-title-matching thread on disk, `listThreadSummaries(query)` (`threadStore.ts:1097-1116`) synchronously runs `fs.readFileSync(filePath, "utf8")` + `JSON.parse(raw)` and scans all `messages[].content`. With 50–100 historical threads (`1–5 MB` each = `100–300 MB` total), typing a 5-letter query fires 2–4 requests that each block the 1-vCPU event loop for `300–1,500+ ms`, stalling active LLM token streaming and SSE heartbeats.
- **Concrete Fix Sketch:**
  - Store a compact searchable text digest / bounded token snippet per thread in `.summaries-index.json` on `saveThread`, or switch search to async `fs.promises.readFile` with raw case-insensitive substring pre-check before `JSON.parse` and a `300ms` client debounce + `AbortController`.
  - **Proving Test:** Test `listThreadSummaries("needle")` across 50 fixture threads asserting `JSON.parse` is never called on files whose raw bytes lack `"needle"` and previous in-flight search requests abort on new keystrokes.

#### `P-F5` — Unconditional 15-Second 5-Endpoint Polling Storm + Per-Request SQLite DDL and Upstream Health Probes

- **Severity:** `medium`
- **Status:** `OPEN PRIOR` (`U4` + server SQLite/probe amplification)
- **Evidence (`file:line`):**
  - `web-ui/app/page.tsx:238-310` (`15_000ms` interval hitting `/api/sandbox-status`, `/api/engine`, `/api/skills`, `/api/deploy`, `/api/projects`)
  - `web-ui/app/api/skills/route.ts:13-48` (`new FlywheelSkillsStore()` opens/closes `node:sqlite` and executes `CREATE TABLE IF NOT EXISTS` DDL on every request)
  - `web-ui/app/api/sandbox-status/route.ts:10-75` & `web-ui/app/api/engine/route.ts:19-91` (4+ live HTTP probes per tick to LLM `/health`, `/v1/models`, `/control/status`, MCP `/health`)
- **What Breaks or Costs (Quantified):** Every open browser tab generates `20` API requests/min, `16+` internal pod-to-pod HTTP probes/min, and `4` synchronous SQLite connection + DDL cycles/min regardless of `activeNavView` or `document.hidden`, causing root `Home` state updates and child re-renders every 15s.
- **Concrete Fix Sketch:** Gate background polling on `!document.hidden`, poll view-specific endpoints (`/api/skills`, `/api/deploy`, `/api/projects`) only when their view is active, raise engine/sandbox status cadence to `45–60s`, and reuse a singleton `FlywheelSkillsStore` handle (matching `getSharedRunLedger()`).
- **Proving Test:** Unit test verifying singleton reuse in `FlywheelSkillsStore` and visibility/view gating on background pollers.

#### `P-F6` — `P3` Still Performs Eager Per-Token String Joins & `thinkingSegments` Array Clones Before the 5-Second Snapshot Timer Check

- **Severity:** `medium`
- **Status:** `INCOMPLETE CLOSURE` (PR #232 / Sink `#7`)
- **Evidence (`file:line`):**
  - `web-ui/lib/chat/roundLoop.ts:1147-1159, 1202-1211`
  - `web-ui/lib/chat/turnEngine.ts:510-518, 538-545`
  - `web-ui/lib/streamSnapshot.ts:99-111`
- **What Breaks or Costs (Quantified):** On every thinking token and every content token (`1,000–5,000` tokens/round), `roundLoop.ts` and `turnEngine.ts` build `accumulatedThoughts.join("\n\n") + "\n\n" + roundThinking`, call `roundThinking.trim()`, and allocate `[...thinkingSegments, { round, text: roundThinking.trim() }]` **before** `streamSnapshot.maybeWrite` checks `now - this.lastWriteMs < this.intervalMs` at `streamSnapshot.ts:111` (which also clones `thinkingSegments` and trims `thought` at `99-106` first). Across a `45,000`-token thinking job (`23js`), `>99%` of those multi-GB cumulative string allocations are immediately discarded.
- **Concrete Fix Sketch:** Add `streamSnapshot.isDue(force)` (checking `this.clock() - this.lastWriteMs >= this.intervalMs` first) and move lines `99-109` of `streamSnapshot.ts` below the interval check so cumulative thought strings and segment arrays are constructed only once per 5s flush and once at round end.
- **Proving Test:** Unit test in `streamSnapshot` / `thoughtStreamDeltaOnly.test.ts` verifying `0` segment clones or cumulative joins occur on throttled sub-5s tokens.

#### `P-F7` — Per-Turn Cold MCP Sessions, Unguarded `!hostAccess` Probe, Per-Round Sync `getHostSettings()`, `O(M^2)` `ReadDedupRegistry` Init, and Single-Slot Overlap Cache Eviction

- **Severity:** `medium`
- **Status:** `NEW`
- **Evidence (`file:line`):**
  - `web-ui/lib/chat/roundLoop.ts:375, 415-433, 452, 745, 2235-2239, 2615, 2889-2893`
  - `web-ui/lib/hostMode.ts:214-224` (`determineHostRunnerState` probes `host-bridge /health` with 1,500ms timeout before checking `if (!hostAccess)`)
  - `web-ui/lib/hostSettings.ts:17-37` (`getHostSettings()` sync `readFileSync` + `JSON.parse` called every round at `roundLoop.ts:745`)
  - `web-ui/lib/readDedup.ts:164-230, 348-360` (`new ReadDedupRegistry(conversationMessages)` runs linear `findPairedCall` per historical read -> `O(M^2)` + SHA-256 re-hashing of all prior reads on turn start)
  - `web-ui/lib/chatDiffs.ts:120-129` (`computeEdits` allocates up to `2,000,000`-cell `Int32Array` synchronously at turn end); `deploy/k8s/web-ui.yaml:76` (`LLM_CONCURRENCY="1"`)
- **What Breaks or Costs (Quantified):**
  - Every turn connects two fresh MCP HTTP/SSE transports + `listTools()` while holding the engine slot lease (`roundLoop.ts:415-433`), probes `host-bridge /health` even when `hostAccess === false` (up to `1.5s` timeout penalty when host runner is offline), and re-reads `host-settings.json` synchronously on every round (`100` rounds = `100` sync reads).
  - On `LLM_CONCURRENCY="1"`, releasing the engine slot for a short `1–5s` read batch (`roundLoop.ts:2235`) allows a second turn to overwrite the single engine slot's KV/SSM prefix cache, costing **`20–53s` of `R = 0` full prompt re-reading** when Turn A resumes. Similarly, `> 70K` batch elisions (`microElision.ts:378-568`) mutate back to Round 1 (`R = 2,734`) even when eliding only messages past the highest `18,432`-token interior checkpoint (`R = 21,167` or `39,816`) would reclaim enough headroom.
- **Concrete Fix Sketch:**
  - Short-circuit `if (!hostAccess)` at the top of `determineHostRunnerState` (`hostMode.ts:214`), hoist `getHostSettings()` out of the `while (true)` loop (or mtime-cache it), acquire the `PrioritySlotScheduler` lease _after_ MCP/Oracle setup (and pool MCP clients), index `tool_calls` in `O(M)` via a `Map` in `ReadDedupRegistry`, and only release the single-slot engine lease for long barrier waits (or when `LLM_CONCURRENCY > 1`).
  - **Proving Test:** Unit tests verifying `determineHostRunnerState(false)` makes `0` `fetch` calls, `getHostSettings()` caches by `mtimeMs`, and `ReadDedupRegistry` indexes 500 messages in `O(M)`.

---

## Section 3 — Track 3: UI Audit

### 3.1 Verification of Shipped UI Iterations 1–2 (`U1, U2, U3, U10, U17`, PR #224)

| Prior ID | Verdict at `b64022ac`    | Verified Clean (`file:line`)                                                                                                                                                                                                                                                                                                         | Remaining Incomplete Edges                                                                                                                                                                                                                        |
| :------- | :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **U1**   | **Substantially Closed** | `roundNarrations` separated from final summary (`roundLoop.ts:1499-1512, 2554-2555`, `liveActivity.ts:166-190`, `ChatStream.tsx:1101-1119`, `ActivityTimeline.tsx:213-222`).                                                                                                                                                         | `messageRender.tsx:436-437` lacks `remark-breaks` for single-newline prose.                                                                                                                                                                       |
| **U2**   | **Substantially Closed** | Unified `isTurnLive`, observed Stop/Steer/Queue, `NowLineBar` `activeTurn.startedAt` + `liveTokPerSec`, `"Live"` pill, SSE `ping`, resilient `pollLiveThread`, drawer `"running"` match, and 4s `BoardView` poll (`ChatStream.tsx:549-575, 1080-1100, 2431-2459, 2749`, `NavigationDrawer.tsx:477-480`, `page.tsx:73-114, 545-642`). | `ThreadsSidebar.tsx:327-330, 513` reads omitted `thread.messages` (`0 chars`); `NowLineBar.tsx:24, 54` uses amber for stall (`U-F8`).                                                                                                             |
| **U3**   | **Partially Closed**     | `host_replace_string` classified in timeline/diffs/`StintCard` (`activityTimeline.ts:135`, `chatUtils.ts:526`, `stintDerivation.ts:189`), `CanvasDiffSheet.tsx:120` keys deduplicated, Grounded File Citation & proof cards retired.                                                                                                 | Duplicate `<CanvasDiffCard>` remains under `<ActivityTimeline>` (`messageRender.tsx:715-774`), timeline opens trace-arg `+` diffs instead of `m.diffs` (`ActivityTimeline.tsx:419`), `chatUtils.ts:244-263` omits `host_replace_string` (`U-F8`). |
| **U10**  | **Partially Closed**     | `NowLineBar` honestly reports `Failed` / `Stopped` / `Incomplete` and ignores `initial-welcome` (`turnSpeed.ts:147-159`, `ChatStream.tsx:546, 2447-2448`).                                                                                                                                                                           | `SandboxGauge`, `ExecutionTrace`, `ModelBottomSheet`, and `BuildsView` still render fabricated static telemetry (`U-F10`).                                                                                                                        |
| **U17**  | **Closed & Sound**       | `LiveActivityHeader.tsx` deleted; `LiveRunBlock.tsx:722-752` trace buttons toggle expansion cleanly.                                                                                                                                                                                                                                 | None.                                                                                                                                                                                                                                             |

---

### 3.2 Track 3 Findings

#### `U-F1` — Known Open Defect (a): Native Command `stderr` Progress Under PowerShell & Fragile Substring/MCP Error Classification

- **Severity:** `high`
- **Status:** `KNOWN OPEN DEFECT (a)` (plus inverted sandbox MCP command status)
- **Evidence (`file:line`):**
  - `host-bridge/server.ts:558-562, 610-637` (`host_run_powershell` spawns `powershell.exe -NoProfile -NonInteractive -Command <command>`, concatenates `stdout` + `stderr` into `output`, sets `success: code === 0`)
  - `host-bridge/jobStore.ts:171-245` (`runPowershellJob` identical `powershell.exe` spawn)
  - `web-ui/lib/chat/roundLoop.ts:1554-1566, 1586-1595` (`classifyExecutionError` checks `resultStr.includes('"status":"EXECUTION_ERROR"') || resultStr.includes('"exit_code":1')` and omits `isError` on `TraceItem`)
  - `mcp-server/src/tools/workspaceTools.ts:717-735` (`workspace_run_command` returns `{ status: "EXECUTION_ERROR", exit_code }` inside `content[0].text` without MCP `isError: true`)
  - `web-ui/lib/activityTimeline.ts:301-335, 600-605` (`extractTraceError` + `traceToTimelineRow`)
  - `web-ui/components/ActivityTimeline.tsx:204-205, 234-235, 249-250, 335-336` (rose failure styling)
- **What Breaks or Costs:**
  1. **PowerShell `NativeCommandError` on `stderr` progress:** `host_run_powershell` invokes Windows PowerShell 5.1 (`powershell.exe`) with no `$ErrorActionPreference` wrapper. Whenever a command or preamble sets `$ErrorActionPreference = 'Stop'` (standard agent practice, explicitly anticipated by `LEADING_SHELL_BOILERPLATE_RE` in `activityTimeline.ts:191-192`), any native binary writing normal progress to `stderr` (`git fetch`, `git push`, `git checkout`, `npm`, `curl`, `cargo`) triggers a terminating `NativeCommandError` before `$LASTEXITCODE` is checked — exiting `powershell.exe` with `code = 1`, setting `success: false, exitCode: 1` (`server.ts:631-632`), and painting the row rose in `ActivityTimeline.tsx`.
  2. **False-positive error classification on `0`-exit output:** In `roundLoop.ts:1556-1560`, any `0`-exit command or file read whose output mentions `"exit_code":1` or `"status":"EXECUTION_ERROR"` (e.g. reading `roundLoop.ts`, `workspaceTools.ts`, or test fixtures) triggers `isExecutionError = true` and increments `consecutiveFailures` (`1581`); in `activityTimeline.ts:303`, any string result starting with `Error`/`Failed` is painted rose regardless of exit code.
  3. **False-negative green status on failed sandbox commands:** `workspace_run_command` (`workspaceTools.ts:717-735`) nests `{ status: "EXECUTION_ERROR", exit_code: 1 }` as a JSON string inside `result.content[0].text` without top-level `isError: true`. Because `roundLoop.ts:1586-1595` drops `isExecutionError` when building `TraceItem` and `extractTraceError` (`activityTimeline.ts:309-329`) only inspects top-level object keys, failed container commands render emerald (`"success"`) in `ActivityTimeline`.
- **Concrete Fix Sketch:**
  - Wrap `host-bridge/server.ts:558` and `host-bridge/jobStore.ts:174` commands so native `stderr` never triggers `NativeCommandError` termination under PowerShell 5.1 (e.g., execute with `$ErrorActionPreference = 'Continue'` or `$PSNativeCommandUseErrorActionPreference = $false` where available and derive `exitCode` from `$LASTEXITCODE` when a native command ran, returning `stdout`, `stderr`, `exitCode`, and `success: exitCode === 0` separately).
  - Replace `JSON.stringify` substring matching in `roundLoop.ts:1554-1566` with structured inspection of host `{ success, exitCode }` and parsed MCP `content[0].text` `{ status, exit_code }`, and persist `isError: isExecutionError` on `TraceItem` (`1586-1595`).
  - Update `extractTraceError` (`activityTimeline.ts:301-335`) to respect explicit `trace.isError === false` / `exitCode === 0` / `success === true` first, and unwrap MCP `content[0].text` payloads when `exit_code !== 0` or `status === "EXECUTION_ERROR"`.
  - **Proving Test:** Unit tests in `activityTimeline.test.ts` and `hostDaemon.test.ts` verifying `0`-exit `git fetch` `stderr` progress renders `"success"`, stdout containing `"exit_code":1` stays `"success"`, and failed `workspace_run_command` renders `"error"`.

#### `U-F2` — Known Open Defect (b): Timeline Tool Outputs Cannot Scroll Vertically, `row.traceResult` Is Unrendered, and Error Summaries Flatten/Truncate at 140 Chars

- **Severity:** `high`
- **Status:** `KNOWN OPEN DEFECT (b)`
- **Evidence (`file:line`):**
  - `web-ui/lib/activityTimeline.ts:68-75, 301-335, 642` (`MAX_ERROR_LEN = 140`; `truncate()` runs `.replace(/\s+/g, " ")` and slices at `139` chars + `"…"`; `traceResult` populated at `:642`)
  - `web-ui/components/ActivityTimeline.tsx:164-188` (`CollapsibleErrorOutput` `div[data-testid="timeline-row-error"]` has `break-words` only — no `max-h-*`, `overflow-y-auto`, `overflow-x-auto`, or `overscroll-contain`)
  - `web-ui/components/ActivityTimeline.tsx:324-374` (`<pre data-testid="timeline-row-details">` at `:363-368` has `overflow-x-auto whitespace-pre-wrap` only and renders `row.traceArgs` only — `row.traceResult` is **never rendered** anywhere in `ActivityTimeline.tsx`)
  - Sibling unscrollable `<pre>` blocks: `web-ui/components/ChatStream.tsx:2724` (error-variant `<pre>` has `overflow-x-auto whitespace-pre-wrap` only, no `max-h-*`/`overflow-y-auto`), `web-ui/components/ExecutionTrace.tsx:166, 176` (`overflow-x-auto max-h-48` / `max-h-56` **without** `overflow-y-auto`, clipping content vertically!), `web-ui/components/LiveRunBlock.tsx:744`, `web-ui/components/TraceWaterfall.tsx:340`, `web-ui/components/CanvasDiffSheet.tsx:137` (missing `overscroll-contain`)
  - Upstream output caps: `host-bridge/server.ts:30, 617-618` (`MAX_OUTPUT_CHARS = 65536`), `web-ui/lib/contextBudget.ts:21, 742-753` (`MAX_TOOL_OUTPUT_CHARS = 64000` on model messages; `roundLoop.ts:1605` stores the bridge's `65,536`-char result in `traces`).
- **What Breaks or Costs:**
  - Expanding `› show output` on a failed row in `ActivityTimeline.tsx` shows at most **139 characters on a single whitespace-collapsed line** (`MAX_ERROR_LEN = 140`), hiding actual compiler errors, test failures, and stack traces at the tail of the output.
  - Non-error shell/tool rows cannot display their `stdout`/`stderr` at all (`row.traceResult` is dead data), `ExecutionTrace.tsx:166, 176` sets `max-h-48`/`max-h-56` with `overflow-x-auto` (which computes `overflow-y: auto` in some browsers and clips/traps without `overscroll-contain`), and `ActivityTimeline.tsx:365` / `ChatStream.tsx:2724` error `<pre>` blocks grow unboundedly down the mobile viewport with no inner vertical scroll.
- **Concrete Fix Sketch:**
  - Add an `extractTraceOutput(result)` helper in `web-ui/lib/activityTimeline.ts` preserving multi-line `output` / `stderr` / `stdout` / MCP text (up to e.g. `16–64 KB`, tail-preferring when `truncated === true` in `host-bridge/server.ts:618` so final exit errors are never cut off!) separate from a concise 1-line header summary.
  - Render expandable `<pre>` output in `ActivityTimeline.tsx` (`CollapsibleErrorOutput` and `TimelineRowView` for `row.traceResult`), and apply `max-h-64 overflow-y-auto overflow-x-auto overscroll-contain` across `ActivityTimeline.tsx:180, 365`, `ChatStream.tsx:2724`, `ExecutionTrace.tsx:166, 176`, `LiveRunBlock.tsx:744`, `TraceWaterfall.tsx:340`, and `overscroll-contain` on `CanvasDiffSheet.tsx:137`.
  - **Proving Test:** Render test in `web-ui/tests/activityTimelineRender.test.ts` asserting a 120-line multi-line command trace renders uncollapsed newlines inside a `max-h-* overflow-y-auto overscroll-contain` `<pre>` on both error and success rows.

#### `U-F3` — Live Thinking Preview (`msg.thought`) Wiped to `undefined` When First `token` Event Streams

- **Severity:** `high`
- **Status:** `REGRESSION` (interaction of PR #232 `thinking` deltas + PR #224 `round_narration` reset)
- **Evidence (`file:line`):**
  - `web-ui/components/ChatStream.tsx:1101-1119, 1167-1197`
  - `web-ui/lib/chatUtils.ts:124-127` (`parseThinkingAndContent` returns `thought: undefined` when input has no `<think>` tags)
- **What Breaks or Costs:** `event.type === "thinking"` (`ChatStream.tsx:1177-1183`) appends reasoning deltas onto `msg.thought`. As soon as the model transitions from thinking to emitting text (`event.type === "token"`, `:1184-1197`), `parseThinkingAndContent(accumulatedRawContent)` returns `{ content, thought: undefined }` (because reasoning arrived over `thinking` events, not `<think>` tags inside `accumulatedRawContent`), and line `1194` sets `thought: parsed.thought` (`undefined`), erasing the `"Thought for Ns"` block mid-round until `done` or reload.
- **Concrete Fix Sketch:** Change `web-ui/components/ChatStream.tsx:1194` to `thought: parsed.thought ?? msg.thought`.
- **Proving Test:** Unit test simulating SSE `thinking` chunks followed by `token` chunks and asserting `msg.thought` stays intact.

#### `U-F4` — Unmemoized `O(M × T)` Mobile Re-Renders on Streaming Tokens & `O(N^2)` `mergeStreamedTokens` Overlap Scan

- **Severity:** `high`
- **Status:** `OPEN PRIOR` (UI Audit Iteration 3 — `U4` client render & frame-time budget)
- **Evidence (`file:line`):**
  - `web-ui/components/ChatStream.tsx:1242, 2562-2594`
  - `web-ui/components/chat/messageRender.tsx:146, 715-774` (`ChatMessageItem` unmemoized)
  - `web-ui/components/ActivityTimeline.tsx:435, 444` (`ActivityTimeline` & `buildActivityTimeline` unmemoized)
  - `web-ui/components/StintCard.tsx:12` & `web-ui/lib/stintDerivation.ts:53` (`deriveStintMetrics` calls `JSON.stringify(result)` on every trace per render)
  - `web-ui/lib/chatStatus.ts:132-159` (`mergeStreamedTokens` unbounded `O(N^2)` suffix/prefix scan)
- **What Breaks or Costs:** On mobile (`375–430px`), every SSE token chunk (`20–60/s`) mutates `messages` and re-renders every message in the thread without `React.memo` or `requestAnimationFrame` batching, re-running `buildActivityTimeline`, `extractFileWriteDiffsFromTraces`, `ReactMarkdown`, and `JSON.stringify(trace.result)` across hundreds of traces per frame, followed by an `O(N^2)` string overlap loop at turn completion.
- **Concrete Fix Sketch:** Wrap `ChatMessageItem`, `ActivityTimeline`, and `StintCard` in `React.memo`, wrap `buildActivityTimeline` and `deriveStintMetrics` in `useMemo` (replacing `JSON.stringify(t.result)` in `stintDerivation.ts:53` with shallow property reads), batch SSE `thinking`/`token` state commits to `requestAnimationFrame`, and bound `mergeStreamedTokens` overlap scanning to a 4 KB window.
- **Proving Test:** Render-count test on a 20-message / 150-trace fixture asserting settled `ChatMessageItem` rows render once while the tail message streams, and unit benchmark on `mergeStreamedTokens` with 64 KB strings.

#### `U-F5` — Design Locks #1–#3 Breaches: 19-File Non-Emerald Accent Spread, 4 Dark-Only Views in Light Mode, 30-File Light Contrast Failures, and 7 Dark Text-Floor Violations

- **Severity:** `high`
- **Status:** `OPEN PRIOR` (UI Audit Iteration 4 — `U5, U6, U8` & Design Locks #1, #2, #3, re-verified at `b64022ac`)
- **Evidence (`file:line`):**
  - **Design Lock #1 (Emerald `#10b981` only; `19` files, `171` Tailwind tokens + `5` hex tokens):** Blue/sky user bubbles (`web-ui/components/chat/messageRender.tsx:67, 72, 87, 90, 96, 214-215`); cyan running tokens (`web-ui/app/design-tokens.css:48-51, 120-123`, `ThreadsSidebar.tsx:361, 427`, `ViewShell.tsx:530`, `ThinkingPanel.tsx:208, 211`, `ExecutionTrace.tsx:166, 187`, `SandboxGauge.tsx:25`, `DiffViewer.tsx:98, 169-170, 195`); non-disconnect amber (`NowLineBar.tsx:24, 54`, `ThreadsSidebar.tsx:381`, `LiveRunBlock.tsx:343, 659-662`, `MorningReportView.tsx:508, 573`, `morning-report/page.tsx:59`, `settings/hostCard.ts:34, 36`, `ArtifactRenderers.tsx:73`, `SvgViewer.tsx:448`, `TraceWaterfall.tsx:71-75`); blue/indigo/purple (`ArtifactCanvas.tsx:209`, `ArtifactRenderers.tsx:59`, `BuildsView.tsx:319`, `DiffViewer.tsx:197`, `ExecutionTrace.tsx:127`, `MorningReportView.tsx:797`, `FileReviewPanel.tsx:285`, `SandboxGauge.tsx:52`, `SvgViewer.tsx:189, 330`, `TraceWaterfall.tsx:64-81`, `ViewShell.tsx:793`); **plus** `LiveRunBlock.tsx:492-495` paints **both** critic pass and critic fail in emerald.
  - **Design Lock #2 (Pure `#000000` dark canvas) & Dark-Only Light Mode (`U5`):** `BoardView.tsx:121-462`, `BoardAddSheet.tsx:155-397`, `CanvasDiffSheet.tsx:70-169`, `ExplorerPanel.tsx:160-338`, `ChatStream.tsx:2744`, `CompletionVerificationBadge.tsx:19, 30`, `SupervisorStatusBadge.tsx:24, 37, 48`, `messageRender.tsx:419-420`, and `app/error.tsx:18-25` lack light-mode surfaces and use `#0e0e12`/`#15151b`/`zinc-900`/`slate-900` dark fills instead of `#000000`. Theme storage precedence is also split (`app-theme || theme` in `app/layout.tsx:50` & `app/morning-report/page.tsx:35` vs `theme || app-theme` in `app/page.tsx:207` & `lib/hooks/useTheme.ts:41-42`).
  - **Design Lock #3 (`zinc-400` dark text floor; `zinc-500` banned) & Light Contrast (`U6`):** **7 files** render un-overridden `< zinc-400` text on dark surfaces (`MorningReportView.tsx:487, 555, 854`, `projects/ProjectTaskList.tsx:80`, `settings/HostZone.tsx:221`, `settings/SelfDeployZone.tsx:86`, `SvgViewer.tsx:318, 349`, `ModelBottomSheet.tsx:177`, `ProjectsView.tsx:737, 885`), **30 files (`148` tokens)** render `< 4.5:1` unprefixed `text-*-400` on light surfaces (`1.9:1–2.56:1`), and `web-ui/tests/accentContrastAudit.test.ts` scans only 2–3 files.
- **What Breaks or Costs:** Breaks all three visual locks across mobile and desktop, leaves four primary views unreadable black islands in Light Mode, paints critic failures green, and leaves automated style guardrails blind to 90%+ of components.
- **Concrete Fix Sketch:** Migrate all non-error/non-disconnect accents (including user bubbles and `--status-running-*`) to emerald `#10b981` or neutral `zinc`, fix `LiveRunBlock.tsx:492-495` fail branch to `rose`, anchor dark canvases on `#000000` with paired `bg-white`/`bg-zinc-50` light classes, replace unprefixed `text-*-400` with `text-zinc-600 dark:text-zinc-400` (`text-emerald-700 dark:text-emerald-400`), lift the 7 dark `< zinc-400` sites to `dark:text-zinc-400`, unify theme key lookup on `theme`, and expand `accentContrastAudit.test.ts` across all `web-ui/components/**/*.tsx` and `web-ui/app/**/*.tsx`.
- **Proving Test:** Repo-wide `accentContrastAudit.test.ts` enforcing 0 banned accent classes, 0 dark `text-zinc-500` / `text-slate-500` tokens, and light-surface pairing on all dark containers.

#### `U-F6` — Design Lock #4 Breach: Chat Header Contains 10+ Extra Chrome Elements + Personal Author Metadata in `layout.tsx`

- **Severity:** `medium`
- **Status:** `OPEN PRIOR` (UI Audit Iteration 4 — `U11, U12` & Design Lock #4)
- **Evidence (`file:line`):**
  - `web-ui/components/ChatStream.tsx:2095-2429` (`SupervisorStatusBadge` `:2176`, `SIMULATION` `:2182`, `Scope` `:2214`, `Compacted` `:2259`, `host-disconnect-chip` `:2275`, `+ New` `:2312`, `Overflow` `:2325`, desktop `Projects`/`Sessions`/`Workspace` tabs & `<h1>` `:2122-2170`)
  - `web-ui/app/layout.tsx:28` (`metadata.authors` contains an individual full name)
- **What Breaks or Costs:** Crowds `375–430px` mobile headers, compresses the context meter and model pill, violates the 3-item Header Lock (`hamburger + context meter + model pill` only, with `NowLineBar` beneath), and emits personal author metadata on every HTML response.
- **Concrete Fix Sketch:** Restrict `ChatStream.tsx` header to hamburger + context meter + model pill on mobile (relocating status chips to the sub-header banner strip and session actions to `NavigationDrawer`), and remove `authors` from `web-ui/app/layout.tsx:28` with a hygiene guard assertion.
- **Proving Test:** Render test in `uirHeaderActivity.test.ts` asserting the header bar contains only those three controls, plus hygiene check on `app/layout.tsx`.

#### `U-F7` — Silent HTTP `200` No-Ops on Manual Compaction & Model Persistence, Plus Stuck Phantom `"running"` Project Tasks

- **Severity:** `high`
- **Status:** `OPEN PRIOR` (UI Audit Iteration 5 — `U7, U9`)
- **Evidence (`file:line`):**
  - `web-ui/components/ChatStream.tsx:937-940` (`POST /api/threads/${threadId}` `{ action: "compact" }`) & `web-ui/app/page.tsx:933, 949` (`{ action: "setModel" }`) vs `web-ui/app/api/threads/[id]/route.ts:416` (falls through returning `200 { thread }`)
  - `web-ui/app/api/projects/[id]/tasks/route.ts:49-55` (`executeInline: false`) & `web-ui/lib/projects/projectRunner.ts:73-74, 136-249` (`mode` and `scheduleTime` ignored)
  - `web-ui/components/ProjectsView.tsx:313, 337, 358, 486, 646` (missing `res.ok` checks)
- **What Breaks or Costs:** Clicking `"Compact history now"` does nothing; per-thread model/effort changes revert on thread switch/reload; clicking Project `"Run Now"` or `"Schedule 2:00 AM"` checks out a `feat/task-*` git branch and inserts an idle `"running"` DB row that permanently blocks subsequent runs (`409`) with zero execution.
- **Concrete Fix Sketch:** Point `ChatStream.tsx:937` at `POST /api/threads/${encodeURIComponent(threadId)}/compact`, implement `action === "setModel"` and a `400 Unknown action` fallback in `api/threads/[id]/route.ts:416`, wire `mode === "now"` to background runner execution and `mode === "schedule"` to `/api/schedules`, and check `res.ok` across `ProjectsView.tsx`.
- **Proving Test:** Route tests verifying `setModel` persistence, `400` on unknown thread action, `/compact` invocation, and non-blocking Project task execution/scheduling.

#### `U-F8` — Incomplete Closures from PR #224: `ThreadsSidebar` Live `0 chars` Readout, Duplicate `<CanvasDiffCard>`, Trace-Arg Diff Fallback, and Missing `host_replace_string` Label

- **Severity:** `medium`
- **Status:** `INCOMPLETE CLOSURE` (PR #224 — `U2, U3`)
- **Evidence (`file:line`):**
  - `web-ui/components/ThreadsSidebar.tsx:327-330, 513` vs `web-ui/lib/threads/threadStore.ts:1037-1064` (`ThreadSummary` omits `messages`, so `progressChars` always evaluates to `0`)
  - `web-ui/components/chat/messageRender.tsx:715-774` (`<CanvasDiffCard>` still rendered below `<ActivityTimeline>`)
  - `web-ui/components/ActivityTimeline.tsx:419, 452-456` (passes `allTurnDiffs` built from `trace.args` rather than persisted pre-image `m.diffs`, losing removed lines on `host_write_file` overwrites)
  - `web-ui/lib/chatUtils.ts:244-263` (`formatHumanReadableTrace` lacks `host_replace_string`)
- **What Breaks or Costs:** Live/stalled sessions in the drawer/sidebar display `0 chars · N total traces`; turns with file edits render duplicate diff surfaces; opening a `host_write_file` diff from the timeline shows `+`-only lines even when full unified `m.diffs` exists on the message.
- **Concrete Fix Sketch:** Include `streamingChars` on `ThreadSummary` in `threadStore.ts:1037-1064`, thread coalesced `m.diffs` into `<ActivityTimeline>` (retiring the duplicate `<CanvasDiffCard>` in `messageRender.tsx:715-774`), and add `host_replace_string` (`Host Edited <file>`) in `chatUtils.ts:256`.
- **Proving Test:** Unit tests asserting non-zero `streamingChars` on `ThreadSummary` and unified pre-image diff display when opening `CanvasDiffSheet` from `ActivityTimeline`.

#### `U-F9` — Absent Scheduler UI (`4` Live APIs Unreachable), Missing Board Edit/Delete Controls, Hidden Settled `Thread ›` Links, and Dead Builds `Rollback`

- **Severity:** `medium`
- **Status:** `OPEN PRIOR` (UI Audit Iteration 5 — `U14, U15` & unshipped Board edit/delete)
- **Evidence (`file:line`):**
  - `web-ui/app/api/schedules/route.ts`, `schedules/[id]/route.ts`, `schedules/[id]/trigger/route.ts`, `scheduler/health/route.ts` (**0** UI callers across `web-ui/components/` and `web-ui/app/`)
  - `web-ui/app/api/board/route.ts:11-55` (`GET`/`POST`/`PATCH` only — no `DELETE`) & `web-ui/components/BoardView.tsx:152-169, 188-211` (`needs-attention` styled emerald; `Brief` and `Thread ›` hidden unless `status === "working"`; zero edit/delete actions; unused `onAskAssistant` at `BoardAddSheet.tsx:20-26`)
  - `web-ui/components/BuildsView.tsx:47-94, 234-241, 254-287` (permanently `disabled` `Rollback`, board fallback drops `threadLink` & hardcodes `"main"`, split `pipelineTask` vs `activeTask`)
- **What Breaks or Costs:** Operators have no UI to inspect/pause/trigger cron schedules, cannot jump from `"done"` or `"needs-attention"` board cards to their execution thread, see failed `"needs-attention"` cards painted positive emerald, and cannot edit or delete board items without editing `board.json`.
- **Concrete Fix Sketch:** Add a Schedules panel wired to `/api/schedules*` and `/api/scheduler/health`; add `BoardStore.remove()` + `DELETE /api/board` + validated edit/delete sheet on `BoardView.tsx`; show `Thread ›` and `Brief` for all statuses whenever `threadLink`/`brief` exists; style `needs-attention` in `rose`; and wire or remove `BuildsView` `Rollback` while preserving `threadLink`.
- **Proving Test:** API + UI tests for `DELETE /api/board`, settled-card `Thread ›` visibility, rose `needs-attention` badge, and Schedules list/trigger rendering.

#### `U-F10` — Fabricated Host Isolation & Engine Telemetry, Unwired Morning Report Review Controls, and Synthetic `SKILL.md` Preview

- **Severity:** `medium`
- **Status:** `OPEN PRIOR` (UI Audit Iteration 5 — `U10` remainder, `U13, U16`)
- **Evidence (`file:line`):**
  - `web-ui/components/ExecutionTrace.tsx:185-217` & `web-ui/components/SandboxGauge.tsx:17-87` (renders `Egress: BLOCKED (Air-Gapped)`, `UID: 10001`, `RootFS: READ_ONLY` even on `tier === "host"` PowerShell/git traces)
  - `web-ui/components/ModelBottomSheet.tsx:28, 316-318` (hardcoded `16 GB VRAM` & static model label) & `web-ui/components/BuildsView.tsx:136-141` (hardcoded `Build Tier Ready`)
  - `web-ui/components/ViewShell.tsx:799`, `web-ui/app/morning-report/page.tsx:84`, `web-ui/components/MorningReportView.tsx:188-206, 239, 475` (`onRevertFlag`/`onAdjustFlag` unpassed -> local-only `Reviewed` state with 0 network calls; empty window silently falls back to `uniqueTasks`)
  - `web-ui/components/SkillsView.tsx:327-339` (client template literal with hardcoded `confidence: 0.94` instead of reading real `SKILL.md`)
- **What Breaks or Costs:** Misleads operators about host-execution security boundaries, GPU/engine state, skill file contents, and whether overnight ambiguity reverts actually executed on the server.
- **Concrete Fix Sketch:** Render distinct host-execution badges when `trace.tier === "host"` or `hostAccess` is enabled; bind `ModelBottomSheet` and `BuildsView` to live `/api/engine` + `/api/sandbox-status` data; wire `onRevertFlag`/`onAdjustFlag` to `POST /api/tasks` and show an honest empty state in `MorningReportView`; serve real candidate markdown from `/api/skills`.
- **Proving Test:** Component tests verifying `tier: "host"` never renders `Air-Gapped`, `MorningReportView` awaits `POST /api/tasks` `res.ok`, and `SkillsView` renders server-returned `SKILL.md` content.

---

## Section 4 — Single Ranked Fix List Across All Tracks

Ranked by `(severity, likelihood × blast radius)` across runtime correctness, performance, security, and mobile UX:

|   Rank | ID(s)                   |   Track   |     Severity     | Summary of Fix                                                                                                                                                                                                                                                                                                                                                                                                           | Primary Target Files                                                                                                                                                                                                                                                                                            |
| -----: | :---------------------- | :-------: | :--------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  **1** | **R1 + R5**             |   1 / 2   |    `critical`    | Split `waitReleaseListeners` vs `waitReacquireListeners` in `PrioritySlotScheduler` (with `finally` abort balance), cap `JobQueue` overlap to 1 per waiter, block same-`threadId` / shared-workspace concurrent overlap, and avoid releasing single-slot (`LLM_CONCURRENCY=1`) KV residency on short read batches.                                                                                                       | `web-ui/lib/slotScheduler.ts`, `web-ui/lib/jobQueue.ts`, `web-ui/lib/chatTurnGate.ts`, `web-ui/lib/chat/roundLoop.ts`                                                                                                                                                                                           |
|  **2** | **R2**                  |     1     |    `critical`    | Fail closed in `evaluateSettledThreadOutcome` unless `thread?.status === "completed"` so deleted (`null`) or `"paused"`/`"active"` threads never stamp board items `"done"`.                                                                                                                                                                                                                                             | `web-ui/lib/board/productionDrain.ts`                                                                                                                                                                                                                                                                           |
|  **3** | **R3**                  |     1     |    `critical`    | Mount `RUN_LEDGER_DB_PATH` and `USER_PROFILE_PATH` onto `/workspace/.agent/` PVC in k8s and reconcile orphaned `'running'` `project_tasks` / `active_task_id` on startup.                                                                                                                                                                                                                                                | `deploy/k8s/web-ui.yaml`, `web-ui/lib/ledger/runLedger.ts`, `web-ui/lib/flywheel/skillsStore.ts`, `web-ui/lib/memory/profile.ts`, `web-ui/lib/projects/projectStore.ts`                                                                                                                                         |
|  **4** | **P-F1**                |     2     |    `critical`    | Replace multi-MB synchronous `touchActiveTurn` JSON rewrites with in-memory/sidecar heartbeat timestamps, drop the duplicate `roundLoop.ts:2263` write after `{ force: true }` snapshots, throttle `< 5s` round-end snapshots, and remove client duplicate `addMessage` POST on SSE `done`.                                                                                                                              | `web-ui/lib/threads/threadStore.ts`, `web-ui/lib/chat/roundLoop.ts`, `web-ui/components/ChatStream.tsx`                                                                                                                                                                                                         |
|  **5** | **R6**                  |     1     |      `high`      | Remove `path.resolve(cwd, "..")` (`"/"`) from `GET /api/files`, validate `[id]` against path traversal in `ThreadStore` & `skillGate`, enforce `confinePathToRoot` + `realpathSync` in `projects/browse`, and add `isSameOriginRequest` + parameter allowlists to `POST /api/deploy` & `projectGit`.                                                                                                                     | `web-ui/app/api/files/route.ts`, `web-ui/lib/threads/threadStore.ts`, `web-ui/lib/subagents/skillGate.ts`, `web-ui/app/api/projects/browse/route.ts`, `web-ui/app/api/deploy/route.ts`, `web-ui/lib/deploy/selfDeploy.ts`, `web-ui/lib/projects/projectGit.ts`                                                  |
|  **6** | **R4**                  |   1 / 2   |      `high`      | Populate `tool_call_id` on all `role: "tool"` messages, defer mid-batch `appendTrailingDirective` calls until after all round `tool` messages, remove duplicate `currentAssistantMessage` push at `roundLoop.ts:2400`, emit skipped `tool` stubs on early exit, wrap barrier MCP `callTool` in `try/catch`, sort `toolCallsAccumulator` by `index`, and keep `tool_calls` groups atomic in elision/compaction.           | `web-ui/lib/chat/roundLoop.ts`, `web-ui/lib/microElision.ts`, `web-ui/lib/llm/provider.ts`, `web-ui/lib/contextBudget.ts`, `web-ui/lib/conversationCompaction.ts`                                                                                                                                               |
|  **7** | **P-F2**                |     2     |      `high`      | Wire `precomputedRawMessageTokens` + round dirty-flag tracking + turn-cached `roundToolSchemaTokens` into `roundLoop.ts` and `turnEngine.ts:runSynthesisPass`, and invalidate after `appendTrailingDirective` in `runChatToolLoop` (7–10+ scans/round -> 1).                                                                                                                                                             | `web-ui/lib/chat/roundLoop.ts`, `web-ui/lib/chat/turnEngine.ts`, `web-ui/lib/contextBudget.ts`                                                                                                                                                                                                                  |
|  **8** | **R7 + R8**             |     1     |      `high`      | Preserve `control` in `BoardStore.migrateIfNeeded`, share a global drain mutex with `POST /api/board/drain`, use atomic temp+rename + fresh re-reads across stores, reconcile dead `"working"` items even when board control is paused/stopped, allow clearing `needsAttention`/`parkedReason`, keep full `item.brief` across handoff/chunking on PVC, cap chunk requeues, and match `"host_git_pr_create"`.             | `web-ui/lib/board/boardStore.ts`, `web-ui/lib/board/boardOrchestrator.ts`, `web-ui/lib/board/productionDrain.ts`, `web-ui/lib/board/dispatcher.ts`, `web-ui/app/api/board/route.ts`, `web-ui/app/api/board/drain/route.ts`, `web-ui/lib/subagents/scheduler.ts`                                                 |
|  **9** | **U-F1 + U-F2**         |     3     |      `high`      | Normalize PowerShell native `stderr` handling (`$ErrorActionPreference` + `$LASTEXITCODE`) in `host-bridge`, replace substring error matching with structured exit/MCP checks + persisted `TraceItem.isError`, preserve full multi-line tool output in `ActivityTimeline` (`row.traceResult`), and add `max-h-64 overflow-y-auto overflow-x-auto overscroll-contain` to all timeline/error `<pre>` blocks.               | `host-bridge/server.ts`, `host-bridge/jobStore.ts`, `web-ui/lib/chat/roundLoop.ts`, `web-ui/lib/activityTimeline.ts`, `web-ui/components/ActivityTimeline.tsx`, `web-ui/components/ChatStream.tsx`, `web-ui/components/ExecutionTrace.tsx`                                                                      |
| **10** | **R9 + U-F3 + P-F6**    | 1 / 2 / 3 |      `high`      | Preserve `msg.thought` on `token` SSE in `ChatStream.tsx:1194`, emit complete round-end `thought` SSE once at round completion (not suppressed by token-1 snapshot), save active `roundThinking` on abort/error, gate cumulative thought string/array building behind `streamSnapshot.isDue()`, guard `isFinalRound` tool execution, and tag synthetic directives (`isDirective: true`).                                 | `web-ui/components/ChatStream.tsx`, `web-ui/lib/chat/roundLoop.ts`, `web-ui/lib/chat/turnEngine.ts`, `web-ui/lib/streamSnapshot.ts`, `web-ui/lib/contextBudget.ts`                                                                                                                                              |
| **11** | **P-F3 + P-F4**         |   2 / 3   |      `high`      | Suppress `pollLiveThread` via `isLocalSseOpen` across prefill & tool waits, add `ETag` (`304`) + compact delta mode on `GET /api/threads/[id]`, drop duplicate `ChatStream.tsx:444` thread fetch, and index searchable thread text in `.summaries-index.json` (eliminating `O(N)` sync multi-MB `JSON.parse` per search keystroke).                                                                                      | `web-ui/app/page.tsx`, `web-ui/lib/streamPollGate.ts`, `web-ui/components/ChatStream.tsx`, `web-ui/app/api/threads/[id]/route.ts`, `web-ui/lib/threads/threadStore.ts`                                                                                                                                          |
| **12** | **U-F4**                |     3     |      `high`      | Memoize `ChatMessageItem`, `ActivityTimeline`, and `StintCard` (`React.memo` + `useMemo`, removing per-render `JSON.stringify` in `stintDerivation.ts:53`), batch SSE state updates to animation frames, and bound `mergeStreamedTokens` overlap checks to 4 KB.                                                                                                                                                         | `web-ui/components/chat/messageRender.tsx`, `web-ui/components/ActivityTimeline.tsx`, `web-ui/components/StintCard.tsx`, `web-ui/lib/stintDerivation.ts`, `web-ui/lib/chatStatus.ts`                                                                                                                            |
| **13** | **U-F5 + U-F6**         |     3     |      `high`      | Enforce Design Locks #1–#4 repo-wide: emerald `#10b981` only (fix blue user bubbles, cyan running tokens, amber stall, emerald-on-fail critic), `#000000` dark canvas + light-mode pairs on the 4 dark-only views, `text-zinc-600 dark:text-zinc-400` across 30 light-contrast + 7 dark-floor files, 3-item `ChatStream` header, remove `layout.tsx:28` author name, and expand `accentContrastAudit.test.ts` repo-wide. | `web-ui/app/design-tokens.css`, `web-ui/app/layout.tsx`, `web-ui/components/ChatStream.tsx`, `web-ui/components/chat/messageRender.tsx`, `web-ui/components/BoardView.tsx`, `web-ui/components/CanvasDiffSheet.tsx`, `web-ui/components/ExplorerPanel.tsx`, `web-ui/tests/accentContrastAudit.test.ts`          |
| **14** | **U-F7**                |     3     |      `high`      | Wire manual compaction to `/api/threads/[id]/compact`, implement `setModel` + `400` unknown-action rejection in `/api/threads/[id]`, wire `POST /api/projects/[id]/tasks` to real background execution / `/api/schedules`, and check `res.ok` in `ProjectsView`.                                                                                                                                                         | `web-ui/components/ChatStream.tsx`, `web-ui/app/page.tsx`, `web-ui/app/api/threads/[id]/route.ts`, `web-ui/app/api/projects/[id]/tasks/route.ts`, `web-ui/lib/projects/projectRunner.ts`, `web-ui/components/ProjectsView.tsx`                                                                                  |
| **15** | **P-F5 + P-F7**         |     2     |     `medium`     | Gate 15s background polling on `!document.hidden` + active view, reuse a singleton `FlywheelSkillsStore` SQLite handle, short-circuit `determineHostRunnerState(false)`, cache `getHostSettings()` by mtime, pool MCP clients outside the slot lease, and index `ReadDedupRegistry` in `O(M)`.                                                                                                                           | `web-ui/app/page.tsx`, `web-ui/app/api/skills/route.ts`, `web-ui/lib/hostMode.ts`, `web-ui/lib/hostSettings.ts`, `web-ui/lib/chat/mcpClients.ts`, `web-ui/lib/readDedup.ts`                                                                                                                                     |
| **16** | **U-F8 + U-F9 + U-F10** |     3     |     `medium`     | Project `streamingChars` on `ThreadSummary`, deduplicate `<CanvasDiffCard>` + pass `m.diffs` to `ActivityTimeline`, ship Schedules UI + Board edit/delete + settled `Thread ›` links + rose `needs-attention`, wire Morning Report Revert/Submit flags, serve real `SKILL.md`, and make host/engine badges honest.                                                                                                       | `web-ui/lib/threads/threadStore.ts`, `web-ui/components/ThreadsSidebar.tsx`, `web-ui/components/BoardView.tsx`, `web-ui/components/BuildsView.tsx`, `web-ui/components/MorningReportView.tsx`, `web-ui/components/SkillsView.tsx`, `web-ui/components/ExecutionTrace.tsx`, `web-ui/components/SandboxGauge.tsx` |
| **17** | **R10 + R11 + R12**     |     1     | `medium` / `low` | Run `SchedulerDaemon` crash recovery on `< 5m` restarts, read raw `taskId` threads before `reconcileThread` in `sweepStalledThreads`, stamp `firstLlmRequestMs` pre-dispatch (`roundLoop.ts:1113`), add timeouts to `bankGitWork`/`connectMcpClient`, return HTTP 400 on malformed JSON bodies, and update `testGate.ts:1075`.                                                                                           | `web-ui/lib/subagents/schedulerDaemon.ts`, `web-ui/lib/threads/threadStore.ts`, `web-ui/lib/chat/roundLoop.ts`, `web-ui/lib/jobChunking.ts`, `web-ui/lib/chat/mcpClients.ts`, `web-ui/lib/testGate.ts`                                                                                                          |

---

## Section 5 — Checked and Found Sound

The following subsystems and invariants were verified directly in the `b64022ac` source tree and confirmed clean:

1. **Test Gate Manifest Completeness & Repo Hygiene (`web-ui/lib/testGate.ts`, `web-ui/tests/gateManifestCompleteness.test.ts`, `web-ui/lib/board/reviewerGate.ts:39-55`):** All `309` `*.test.ts` files in `web-ui/tests/` are wired into `MAPPING_RULES` with zero orphan test files, and `git diff 6402579..b64022ac` across all workspaces produces **0** hits against all 15 `BANNED_HYGIENE_PATTERNS`.
2. **Below-Watermark Prefix-Cache Preservation (`P0`, `web-ui/lib/microElision.ts:40, 47, 94-124`, `web-ui/lib/chat/roundLoop.ts:802-820`):** Strictly defers all three micro-elision mutation passes below `70,000` effective tokens (`0.7 * 100,000`) and enforces a `+10,000`-token rearm floor after any sweep, keeping `conversationMessages` append-only across normal `< 70K` turns.
3. **Static System Header & Layer-1 Progressive Tool Schema Stability (`P1`, `web-ui/app/api/chat/route.ts:295-334`, `web-ui/lib/progressiveTools.ts:289-392`, `web-ui/lib/chat/roundLoop.ts:780-781, 1793-1802`, `web-ui/lib/llm/provider.ts:448-570`):** `SYSTEM_PROMPT` contains no volatile timestamps/nonces, `mergeSystemDirective` has zero production callers, `roundTools` stays byte-identical across web-budget exhaustion and `describe_tool` lookups, and `normalizeOpenAIMessages` leaves prior messages intact when trailing directives are appended.
4. **Parallel Read-Only Batch Partitioning & Concurrency Cap (`P2`, `web-ui/lib/chat/toolFanout.ts:10-107`, `web-ui/lib/chat/roundLoop.ts:1708-1899`):** `READ_ONLY_FANOUT_TOOLS` admits only side-effect-free lookups (`12` tools), isolates all `25` mutating/budgeted tools as sequential barriers, caps concurrency at `TOOL_FANOUT_CAP = 8`, and commits results deterministically in model-emitted order.
5. **Mid-Turn Hybrid Compaction Gate & Fit-Ladder Dirty-Bit Coverage (`P5` / `P6` core, `web-ui/lib/conversationCompaction.ts:127-132, 698-726`, `web-ui/lib/contextBudget.ts:1165, 1183, 1224, 1265`):** `resolveMidTurnHybridEnabled()` defaults `false` (preventing mid-turn secondary LLM cache evictions on single-slot engines), extraction compaction preserves `messages[0]` (`R_base ~ 2,734`) and verbatim `firstUserIdx`, and all 4 internal mutation rungs inside `fitConversationToBudget` call `markDirty()`.
6. **Bounded SSE Tail Reader & In-Process Drain Writer (`F5`, `web-ui/lib/board/streamTail.ts:18-93`, `web-ui/lib/chat/turnEngine.ts:152-161`, `web-ui/lib/board/productionDrain.ts:556-565`):** `STREAM_TAIL_CAP_BYTES = 256 KiB` aligns UTF-8 continuation bytes and releases reader locks in `finally`; `inProcessConsumer` drops backpressured SSE writes without aborting `runChatTurn` while `productionDrain` awaits `waitForTurnSettled`.
7. **Cumulative Token & Dispatched-Round Rollups (`F10` / `F11`, `web-ui/lib/tokenEconomics.ts:1-120`, `web-ui/lib/chat/roundLoop.ts:680, 1109, 1124-1129, 2425, 2658-2661, 2735-2740`):** `turnState.cumulativeOutputTokens` and `dispatchedRounds` accumulate accurately across tool rounds, terminal rounds, synthesis passes, and aborts.
8. **30-Second Turn & Host-Tool Heartbeats + Queued-Turn Stall Protection (`F4` / `F13`, `web-ui/lib/chat/roundLoop.ts:337-348, 2865-2868`, `web-ui/lib/hostMode.ts:363, 426-459`, `web-ui/lib/threads/liveness.ts:48-60`, `web-ui/app/api/chat/route.ts:91-112, 266, 514-526`):** Keeps active 600s host commands alive inside `STALL_WINDOW_MS`, protects queued turns via `queuedForExecution`, prioritizes interactive `P0_OWNER` ahead of `P1_BUILDER` board drain turns, and cleans up live registries on pre-start aborts.
9. **Explorer Path Confinement, Operator Memory Cap, Monster Intake Validation, and Shadow-Stage Gates (`web-ui/lib/explorer/explorerFs.ts:43-203`, `web-ui/lib/memory/operatorMemory.ts:81-124`, `web-ui/lib/board/monsterIntake.ts:186-535`, `web-ui/lib/board/reviewerGate.ts:114-298`, `web-ui/lib/board/flowMonitor.ts:113-247`, `web-ui/lib/deploy/selfDeployVerified.ts:75-178`):** Explorer confines paths and caps reads at 256 KB; operator memory enforces the 2,000-char ceiling atomically; Monster Intake validates schemas and dependency cycles before writing; Stages 2–4 default `false` and enforce deterministic merge/rollback checks.
10. **Auto-Follow Scroll State Machine, Reconcile Poll Backoff, Diff Row Parser, and Command Dialect Guard (`web-ui/lib/autoFollow.ts:5-40`, `web-ui/lib/reconcilePollPolicy.ts:13-50`, `web-ui/lib/canvas.ts:188-249`, `web-ui/lib/commandDialectGuard.ts:63-103`, `web-ui/components/chat/compactionPill.tsx:8-67`):** Deterministic bottom-threshold pinning, bounded exponential poll backoff with `visibilitychange` pause/resume, `O(lines)` unified diff row parsing, quote-aware PowerShell dialect linting, and contrast-compliant compaction pills.
