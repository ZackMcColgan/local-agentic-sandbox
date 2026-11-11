# Chat Runtime Shakeout: Queue + Steer Run Log

**Date:** 2026-11-06  
**Agent:** Autonomous Agent  
**Branch:** `feature/chat-queue-steer` (tracking `origin/feature/chat-queue-steer`, based on `origin/develop` @ `06fb0bd`)  

---

## Phase 0 — Ground Truth & Census

### Deployment Census
- **Kubernetes Namespaces & Pods:**
  - `web-ui`: `local-agentic-sandbox-web-ui:v-18ddd43-mw4arfie` (Pod `web-ui-675bcb5f88-vnnvc`, 1/1 Running)
  - `mcp-runner`: `local-agentic-sandbox-mcp-server:v-e4f46f7-mw39zew1` (Pod `mcp-runner-69977b988c-k68kf`, 1/1 Running)
  - `browser-mcp`: `local-agentic-sandbox-browser-mcp:v-bd21b85-mvxz06us` (Pod `browser-mcp-66fbf86d65-cwlxm`, 1/1 Running)
  - `qdrant-0`: `qdrant/qdrant:v1.11.0` (1/1 Running)
  - `otel-collector`: `jaegertracing/all-in-one:1.53` (CrashLoopBackOff, pre-existing infra issue)
- **Rollback Tag:** `v-18ddd43-mw4arfie`
- **Ancestry Check:**
  - `4bc71fc` (PR #48 / CHAT-8) is an ancestor of `18ddd43` (Verified: `git merge-base --is-ancestor 4bc71fc 18ddd43` -> exit code 0).
  - `18ddd43` (PR #49 / CHAT-5) is an ancestor of `origin/develop` (`06fb0bd`).
  - `06fb0bd` contains both PR #48 and PR #49.
  - The deployed web-ui image tag matches commit `18ddd43`, so it already includes PR #48 and PR #49. It is NOT a stale deploy predating PR #48.

### Salvage Survey
- Prior session banked commit `7e81488` (`checkpoint: presence fix + queue draft + presence tests (WIP, stopped on request)`) to `feature/chat-queue-steer`.
- Files in commit `7e81488`:
  - `web-ui/app/api/chat/route.ts` (presence marking)
  - `web-ui/app/api/threads/[id]/route.ts` (presence extraction and activeTurn in thread response)
  - `web-ui/lib/threads/threadStore.ts` (activeTurn field and methods)
  - `web-ui/tests/chatQueue.test.ts` (preliminary queue unit tests)
  - `web-ui/tests/chatTurnPresence.test.ts` (preliminary presence tests)
- Worktree clean, stashes intact.

### Host Bridge Status
- `GET http://127.0.0.1:8765/health` -> HTTP 200 OK (`pid: 22352`).

---

## Phase 1 — Diagnosis (INV-A & INV-B)

### INV-A: Turn-Death Forensics
- Examined both dead threads on disk in `/workspace/.agent/threads/`:
  1. `thread-1793953864369-i4jn.json`: 28 traces, terminated with `"⚠️ [Turn incomplete: Stream aborted or disconnected.]"` due to client disconnect.
  2. `thread-1793980342870-vvdn.json`: 25 tool rounds executed. The model in round 25 streamed text (`"Design is settled and I've confirmed..."`) with 11.8k chars of thinking. At round 25 completion, `streamLlmChat` returned zero content tokens during final synthesis pass (or model generated pure `<think>` tokens).
- Root cause: Model synthesis pass produced empty completion tokens. In `route.ts`, when synthesis text is empty after tool execution, line 1405 sets `cleanedContent = "⚠️ [Turn incomplete: Tool execution concluded without synthesis text. Traces captured above.]"`. `mergeStreamedTokens` retained the previously streamed preamble and appended the honest warning banner. No code regression was introduced in PR #48/#49; the logic faithfully preserved what was emitted.

### INV-B: Cross-Device Live Visibility Probe
- Probes A & B (`probe-a-out.txt`, `probe-b-out.txt`) demonstrated that in the deployed build, watcher devices saw the user message at ~4.1s but saw 0 assistant activity until the first content token was streamed (at 22.3s for direction A, 13.3s for direction B).
- Blind window: **~9.2s to 18.2s**. During the model's reasoning and tool-listing phase, no snapshot existed on disk because snapshots required non-empty content tokens.

---

## Phase 2 — Presence Fix (INV-B)
- **Active Turn Marker:** Added `markTurnActive`, `getActiveTurn`, `clearTurnActive` to `threadStore.ts`.
- **API Exposal:** Updated `GET /api/threads/[id]` to return `activeTurn` immediately upon turn creation, even before the thread file is written to disk.
- **Tests:** Fixed mock engine lifecycle in `web-ui/tests/chatTurnPresence.test.ts`. All 7 subtests passed (7/7).
- **Banked Commit:** `9f9b61e` pushed to origin.

---

## Phase 3 — Client-Side Message Queue
- **Queue Implementation:** Implemented `web-ui/lib/chatQueue.ts` implementing `StorageLike`, FIFO operations, `decideSendAction`, and `drainNextForTurnEnd`.
- **ChatStream Wiring:**
  - Send-while-running enqueues text follow-ups.
  - Attachments while running are blocked with an informative error hint.
  - Queue deck with chips rendered above composer with per-item `×` and `Clear all`.
  - Normal `DONE` drains exactly one item and submits it as a follow-up turn.
  - Abort / error endings pause the queue without draining or clearing.
- **Verification:**
  - `web-ui/tests/chatQueue.test.ts` (17/17 passed).
  - Change-aware gate: 234/234 passed in 17.5s (<90s budget).
- **Banked Commit:** `0520a2a` pushed to origin.

---

## Phase 4 — Mid-Turn Steer Mailbox
- **Mailbox Implementation:**
  - Added sidecar store methods to `ThreadStore` in `web-ui/lib/threads/threadStore.ts`: `appendSteer`, `consumeSteers`, `getPendingSteers`, `clearSteers`.
  - Added endpoint `POST /api/threads/[id]/steer` returning `{ success: true, pendingCount }`.
- **Route & Stream Wiring:**
  - `app/api/chat/route.ts` consumes pending steers at every round boundary and immediately prior to final synthesis.
  - Consumed steers are injected into `conversationMessages` as `[Steer from user, mid-turn] ...` and persisted into the thread transcript in position.
  - Route emits SSE event `{ type: "steer", texts }`.
  - Unconsumed steers at turn end return in `done` event payload as `pendingSteers`.
- **Client UI:**
  - Active turn composer displays `Queue` (default) vs `Steer` selector.
  - `steer` event renders injected prompt in transcript.
  - `pendingSteers` in `done` are auto-queued as chips.
- **Verification:**
  - `web-ui/tests/chatSteer.test.ts` (8/8 passed).
  - Regression suites (`chatQueue`, `chatStreamTokenPreservation`, `chatLiveVisibility`, `chatContextBudget`, `chatActionDiscipline`, `chatTurnHonesty`): 82/82 passed.
  - Change-aware gate: 337/337 passed in 25.9s (<90s budget).
- **Banked Commits:** `39719bc`, `f1fab48`, `4ca0c42` pushed to origin.

---

## Phase 5 — Deploy & Live Verification
- **Deployed Build:** `local-agentic-sandbox-web-ui:v-4ca0c42-mw5my380`.
- **Rollout:** Successfully rolled out to Kubernetes `deployment/web-ui`.
- **End-to-End Live Verification:**
  - `http://127.0.0.1:3001` answered HTTP 200.
  - `http://127.0.0.1:80` answered HTTP 200.
  - `http://192.168.50.254:80` (LAN bridge) answered HTTP 200.
  - **Live Probe Verification (`scripts/verify-live-turn.js`):**
    - First presence detected: **114 ms** after turn start (blind window reduced from 18s to **0.114s**).
    - Full turn completed in 12.7s with 44 thought chunks, 3 tokens, and `done` event.
    - Active turn presence cleared to `null` on turn completion.
    - `POST /api/threads/[id]/steer` returned `{ "success": true, "pendingCount": 1 }`.
    - Thread persisted with both user and assistant messages intact.
- **Rollback Tag:** Not needed (`v-18ddd43-mw4arfie` preserved as rollback reference).

---

## Phase 7 — Steer Effectiveness Diagnosis & Fix

### Step 0 Forensics: Owner's Thread Analysis
- **Thread ID:** `thread-1794016475206-zz14.json`
- **User Prompt:** `"What's the weather today in Spanish Fort AL?"` (Timestamp: `2026-11-07T01:54:44.376Z`)
- **Execution Timeline:**
  1. Round 0: Model invoked `search_web` for Spanish Fort AccuWeather forecast.
  2. Round 1: Model received tool result and streamed full final weather markdown (`"In Spanish Fort, AL, today's weather..."`).
  3. Round 1 produced 0 further tool calls.
  4. Loop exited. Route checked pre-synthesis at line 1354.
  5. Steer `"Create a svg of it"` arrived mid-turn and was sitting in mailbox.
  6. Route called `consumeSteers(activeThreadId)`:
     - Consumed steer and appended `[Steer from user, mid-turn] Create a svg of it` to `conversationMessages`.
     - Immediately persisted steer message into thread transcript (`01:56:06.027Z`).
  7. Route evaluated `shouldRunPostToolSynthesis`:
     - `lingeringToolCallsCount === 0`
     - `assistantContent` was already full weather response
     - `userPrompt` had no SVG intent
     - Result: `shouldRunPostToolSynthesis` returned `false`!
  8. Synthesis request was **skipped**.
  9. Turn ended, emitting `done` and saving assistant message (`01:56:06.033Z`).
- **RCA Verdict:** The steer was consumed from the mailbox and written to the thread transcript before checking whether an LLM request would actually be made. Because post-tool synthesis did not trigger, no model call followed, leaving the steer persisted as delivered without ever reaching any model prompt.

### The Fix
1. In `app/api/chat/route.ts`:
   - Round boundary consumption moved after `canContinueToolLoop()` check so steers are never consumed into a round that will immediately abort/break.
   - Pre-synthesis consumption check: If `pendingLateSteers.length > 0`, synthesis pass is guaranteed (`shouldSynthesize = pendingLateSteers.length > 0 || shouldRunPostToolSynthesis(...)`).
   - Steers are only consumed from the mailbox and persisted into the transcript inside `if (shouldSynthesize)`, strictly guaranteeing they are dispatched in the model request.
   - Any steer arriving when no model request can be made is left in mailbox and returned via `pendingSteers` in `done` (TOO LATE -> auto-queued as chip).
2. Tests:
   - Added behavioral tests in `web-ui/tests/chatSteer.test.ts` verifying late-steers force synthesis and appear in model request, and verifying unconsumed late steers are not persisted to transcript.
   - Full gate passed: 176/176 tests green in 27.9s (<90s budget).
3. Deployed:
   - Built and rolled out image `local-agentic-sandbox-web-ui:v-7447231-test1`.
   - Verified HTTP 200 on `localhost:3001`, `localhost:80`, and LAN `192.168.50.254:80`.


---

## Phase 8 — Turn-Lifetime Decoupling & CI Green (Jobs 0, 1, 2)

### Job 0 & Job 1: Server-Side Turn Lifetime Decoupling (`614fa10`)
- **Root Cause:** Previously, `req.signal` abort (triggered whenever a client refreshed the page, closed the tab, or put a phone to sleep) aborted the server-side turn and persisted `"⚠️ [Turn incomplete: Stream aborted or disconnected.]"`. Additionally, if a reload occurred during MCP setup / reasoning before the first content token arrived, no assistant placeholder existed on disk yet, causing a temporary visual hole on reload. Finally, in `POST /api/threads/[id]` (`action: "stop"`), reading `thread` before `abortActiveTurn(thread.id)` and saving that stale reference after `unloadAllModels()` could overwrite the aborted message state.
- **Fix (`614fa10`):**
  1. Decoupled `clientDisconnected` (SSE stream closed / `req.signal` aborted) from `turnAbortController` (explicit user Stop via `POST /api/threads/[id]` `{ action: "stop" }`). Client disconnects now log `[ChatRoute] Client SSE connection disconnected... Turn continuing detached server-side` and allow the tool loop, steer consumption, streaming snapshots, and final synthesis/persistence to run to natural completion.
  2. Seeded an initial `status: "streaming"` assistant message placeholder at turn start (and filtered empty streaming placeholders out of `buildModelMessages` so LLM prompts stay clean), eliminating reload holes during pre-token phases.
  3. Anchored `activeExecutionSet`, `activeTurnRegistry`, and `activeTurnAbortControllers` on `globalThis` and updated `POST /api/threads/[id]` (`action: "stop"`) to reload `updatedThread` after `abortActiveTurn(thread.id)`.
  4. Raced `reader.read()` against `signal` abort in `OllamaProvider.streamChat` and `LlamaCppProvider.streamChat` so explicit Stop halts open HTTP streams immediately.
- **Verification:**
  - 7 targeted suites (`chatTurnHonesty`, `chatLiveVisibility`, `chatStreamTokenPreservation`, `chatSteer`, `chatTurnPresence`, `chatQueue`, `chatPersistenceDecoupling`): **74/74 passed** (0 failed).
  - Deployed `local-agentic-sandbox-web-ui:v-614fa10` and verified live at mobile viewport (`390x844`):
    - Mid-turn disconnect + reload shows `Streaming` badge immediately (zero hole) and completes naturally server-side (`thread-1794047006240-4mdb`).
    - Explicit Stop (`thread-1794047022355-ydoh`) halts turn and renders `Incomplete` badge + `"⚠️ [Turn incomplete: Stream aborted or disconnected.]"`.

### Job 2: Repo CI Green on PR #50
- GitHub Actions Run `42362482744` on branch `feature/chat-queue-steer` (head `614fa10`) completed with **`success`** in `5m38s`.

---

## Phase 9 — Job 3: Overnight Chat Runtime Shakeout Battery (`7e7b40a`, `69c5047`, `67fb713`)

Executed adversarial probes A–G against the deployed chat runtime, registered 3 newly uncovered defects (`CHAT-10`, `CHAT-11`, `CHAT-12`) in `docs/shakeout-register.md`, wrote failing behavioral tests first, committed 1 atomic fix per defect, deployed `local-agentic-sandbox-web-ui:v-67fb713`, and re-verified 100% pass across all probes:

1. **`[CHAT-10]` (`7e7b40a` — Server Restart Mid-Turn Reconciliation):**
   - Fixed `ThreadStore.addMessage` so `status: "streaming"` snapshots keep `thread.status = "active"` (instead of flipping `thread.status` to `"completed"` on existing threads) and `status: "incomplete" | "error"` sets `thread.status = "stopped"`.
   - Fixed `ThreadStore.reconcileThread` so any orphaned `status: "streaming"` assistant message on a non-live thread is reconciled to `status: "incomplete"`, `isStopped: true`, with `"⚠️ [Turn incomplete: Server restarted or turn interrupted.]"`.
   - Verified via unit test 4 in `chatPersistenceDecoupling.test.ts` and live `kubectl rollout restart deployment/web-ui` mid-turn on `thread-1794048592462-otwu`.
2. **`[CHAT-11]` (`69c5047` — Steer to Nonexistent Thread 404):**
   - Updated `POST /api/threads/[id]/steer` to verify `store.getThread(id) || getActiveTurn(id) || activeExecutionSet.has(id)` and return HTTP `404` (`{ error: "Thread not found" }`) instead of `200 OK` with an orphan `.steer.json` sidecar.
   - Verified via `chatSteer.test.ts` and live Probe C3.
3. **`[CHAT-12]` (`67fb713` — Honest Rejection of Unavailable Model Names):**
   - Updated `POST /api/chat` to validate `requestedModel` against `"auto"`, `DEFAULT_MODEL`, `DEFAULT_PRIMARY_MODEL`, `DEFAULT_SUBAGENT_MODEL`, legacy default aliases, and `PRESET_MODEL_PROFILES`. Unknown model names fail fast with `Model "<id>" is not available on the active inference engine.`, emitting an SSE `error` event and persisting `status: "error"` without calling the LLM backend.
   - Verified via Test 5 in `chatPersistenceDecoupling.test.ts` and live Probe E1.
- **Targeted Suites:** **77 / 77 passed** (`chatTurnHonesty`, `chatLiveVisibility`, `chatStreamTokenPreservation`, `chatSteer`, `chatTurnPresence`, `chatQueue`, `chatPersistenceDecoupling`).

---

## Phase 10 — Job 4: Build Mode Analysis, Fix-Up, and End-to-End Proof (`101871e`)

### 1. 7-Question Architecture & Live Stack Analysis
- **Q1 (Wiring):** `POST /api/threads` (`action: "launchTask" | "build"`) -> `generatePlanSpec` -> `OvernightSupervisor.executeTaskWithRecovery` -> `createProductionStepExecutor` -> `WorkerPool` (`BuilderWorker`, `CriticWorker`) -> `WorkerGitOps` -> `ThreadStore` & `RunLedger`. Fixed hardcoded `"swift-15-27b-mtp"` fallbacks across `workerPool.ts`, `planner.ts`, `supervisor.ts`, `scheduler.ts`, and `app/api/threads/route.ts` to honor `process.env.MODEL_NAME` (`qwen3.8-flash-next-gyro-gyro-s`).
- **Q2 (Token Economics):** Fixed `LlamaCppProvider.generate` (`web-ui/lib/llm/provider.ts:808-814`) so `req.options.num_predict` always adds `thinkingBudget` (`4096` default, matching `OllamaProvider.generate`), preventing reasoning tokens from starving Critic (`512 + 4096 = 4608`), Planner (`2048 + 4096 = 6144`), or Builder (`4096 + 4096 = 8192`) output.
- **Q3 (Single-Slot Contention):** Verified live (`job4-build-smoke-probe.log`): `WorkerPool` enforces `maxConcurrency = 1`; concurrent Chat turns during an active Build task queue cleanly inside Strata's HTTP server without error or deadlock (`Concurrent Chat Turn finished — done: true, error: null, content: CONTENTION_OK`).
- **Q4 (Workspace & Fresh-Pull GitOps):** Updated `WorkerGitOps.createAndSwitchBranch` (`web-ui/lib/git/workerGitOps.ts`) to fetch `origin/develop` and branch from `origin/develop` (`git checkout -f -B <branchName> origin/develop`) when `origin` remote is configured, and seeded `/workspace` in the cluster PVC with `origin/develop` (`06fb0bdc540b9e3fb61b486e3f7b759ef229353a`).
- **Q5–Q7 (Lifecycle Honesty, Morning Report, Scheduler):** Verified terminal state reconciliation (`completed`, `parked`, `paused`, `stopped`), idempotent `stageAndCommit` audit logging, `/api/morning-report` artifact/SHA reporting, and `UnattendedScheduler` model wiring.
- **Worth-It Gate Verdict:** **WORTH FIXING AND PROVING TONIGHT.**

### 2. End-to-End Proof Run (`task-1794049952744`, `thread-1794049952748-hnzm`)
- Deployed `local-agentic-sandbox-web-ui:v-101871e` and launched the proof task with zero mid-run intervention.
- Branched `feat/task-179404995274` from `origin/develop` (`06fb0bdc540b9e3fb61b486e3f7b759ef229353a`), generated `docs/build-mode-e2e-proof.md`, committed `618643a7a66b01885139e839eb84919dd835dbb0`, transitioned `thread.status` and `task.status` to `"completed"` in `1m 14s`, and verified full entry in `GET /api/morning-report`.
- **Verdict:** **`BUILD PROVEN (clean)`**



---

## Phase 11 — Job 5: Graduation Probe (`GRADUATION BLOCKED`) & `INTERRUPT-STEER` Implementation

### 1. Graduation Probe (`thread-1794050126335-i74n`)
- Dispatched a 1-chunk survey job on `thread-1794050126335-i74n` asking the sandbox chat agent to inspect the steer implementation and write a 10-line design note for `INTERRUPT-STEER`.
- The sandbox chat agent executed 19 tool calls and completed cleanly (`status: "completed"`), producing a 10-point design note (`interrupt-steer-survey.md`).
- **Verdict:** **`GRADUATION BLOCKED`** — three concrete self-hosting capability gaps diagnosed from live probe evidence:
  1. **Container `/workspace` PVC vs. Host Checkout Isolation:** In Chat mode without Host Mode, `workspace_*` tools execute inside `mcp-runner` against the cluster `/workspace` PVC (tracking `origin/develop` `06fb0bd`) rather than the host checkout (`C:\Users\zackm\Desktop\repos\local-agentic-sandbox` on `feature/chat-queue-steer`), so unmerged branch files (`steer/route.ts`) are not visible in `/workspace` until pushed/fetched.
  2. **Cross-Pod UID/Umask Mismatch on `/workspace` Subdirectories:** `web-ui` runs as `uid=1001` (`nextjs`) while `mcp-runner` runs as `uid=10001, gid=10001`. When `web-ui` runs `git checkout` in `/workspace`, newly created subdirectories (`/workspace/docs`) are created with mode `0755` (`uid=1001, gid=10001`), preventing `mcp-runner` (`uid=10001`) from creating new files inside `/workspace/docs` without `0775` group-write permissions.
  3. **Host Mode Interactive Approval Gate:** In Host Mode (`host_*` tools), `host_run_powershell` and `host_write_file` gate command/write execution behind interactive human approval or the host-runner daemon (`:8765`), preventing unattended test+commit loops from inside a chat turn.

### 2. `INTERRUPT-STEER` Implementation & Behavioral Verification
- **`web-ui/lib/threads/threadStore.ts`:** Added `activeRoundAbortControllers` on `globalThis` and exported `registerRoundAbortController`, `clearRoundAbortController`, and `interruptActiveTurnStream(threadId)`.
- **`web-ui/app/api/threads/[id]/steer/route.ts`:** Accepted `{ text, interrupt?: boolean }`, invoked `interruptActiveTurnStream(id)` when `interrupt === true`, and returned `{ success: true, pendingCount, interrupted }`.
- **`web-ui/app/api/chat/route.ts`:** Registered a per-round `roundAbortController` combined via `AbortSignal.any([turnAbortController.signal, roundAbortController.signal])`. When interrupted by a steer without an explicit turn stop, partial round text and thinking are preserved in `conversationMessages`, `groundingDirectivePending = true` allows the loop to continue, and the next iteration immediately consumes the steer and dispatches the redirected LLM request.
- **`web-ui/components/ChatStream.tsx`:** Updated mid-turn Steer submission to pass `interrupt: true`.
- **`web-ui/tests/chatSteer.test.ts`:** Added behavioral test verifying in-flight stream interruption, partial context preservation, immediate steer consumption, and clean `completed` status (**11 / 11 passed**).

---

## Phase 12 — Job 6: House-Rule Improvements & Final Verification
- Added bounded-retry (`max 2 identical runs, max 3 strategies -> BLOCKED`), targeted-test-first, paging discipline, and single-writer rules to `AGENTS.md`, `GEMINI.md`, and `SYSTEM_PROMPT` in `web-ui/app/api/chat/route.ts`.
- Verified `web-ui/tests/repoHygiene.test.ts` passes **5 / 5**.

---

## Phase 13 — CAMPAIGN: Live Chat Stress Test & Host Mode Settings Default (Nov 8, 2026)

### 1. Defect #0: Global Host Mode Switch Default ON & Read-Only Status Chip
- **Directive:** Global Host switch in Settings menu (`[data-testid="host-access-toggle-btn"]`), default ON, persisted server-side at `host-settings.json` (no file = enabled). Thread header keeps ONLY a read-only status chip (`[data-testid="host-access-chip"]`), per-thread interactive toggle button removed. Health gate strictly maintained (switch ON + daemon down = UNAVAILABLE, no host tools). Subagent/scheduled contexts strictly prohibited from host tools.
- **Implementation:**
  - `web-ui/lib/hostSettings.ts`: Added `hostAccessEnabled: boolean` defaulting to `true`.
  - `web-ui/app/api/settings/host/route.ts`: GET/POST handling for `hostAccessEnabled`.
  - `web-ui/app/api/chat/route.ts`: Default thread host access to global setting; prohibited subagent/scheduled context check.
  - `web-ui/app/api/host/status/route.ts`: Default `hostAccess` to global setting.
  - `web-ui/lib/threads/threadStore.ts`: `createThread` sets `hostAccess` to `getHostSettings().hostAccessEnabled`.
  - `web-ui/components/SettingsView.tsx`: Global Host Access toggle switch (`[data-testid="host-access-toggle-btn"]`) with status badge and persistence.
  - `web-ui/components/ChatStream.tsx`: Replaced per-thread interactive toggle button with read-only status chip (`[data-testid="host-access-chip"]`).
- **Tests & Gate:**
  - `web-ui/tests/hostSettingsDefault.test.ts`: 5/5 pass.
  - `npm run test:gate`: 473/473 pass in 38.997s (<90s budget).
  - Next.js production build: clean exit code 0.
- **PR & Deploy:**
  - Branch: `feature/host-settings-default` (commit `383ac41`).
  - PR: #57 (https://github.com/ZackMcColgan/local-agentic-sandbox/pull/57).
  - Deployed Image: `local-agentic-sandbox-web-ui:v-383ac41-mw8440fz`.
  - Rollback Armed Baseline: `local-agentic-sandbox-web-ui:v-2a1f40f-mw81k1uh`.
- **Live Verification:** Verified on `http://192.168.50.254`. Brand-new threads default to `Host access ON`. Settings toggle persists across pod restart. 4 visual screenshot permutations verified across Desktop/Mobile and Dark/Light.

### 2. Live Acceptance Battery — Double Green Proof Matrix

| Scenario | Pass 1 Duration | Pass 1 Result | Pass 2 Duration | Pass 2 Result | Live Verification Details |
|---|---|---|---|---|---|
| **S1: Short-flow sanity** | 46.5s | PASS | 27.2s | PASS | Weather search + copy button clicked ("Copied") + contextual reasoning turn |
| **S2: Artifact correctness** | 41.2s | PASS | 99.5s | PASS | Spanish Fort HTML with inline SVG -> 0 vector cards, code card + sandboxed iframe preview |
| **S3: SVG regression** | 105.3s | PASS | 202.1s | PASS | Standalone SVG architecture -> pure vector diagram, 213 SVG DOM elements, vector controls |
| **S4: Compaction & gist** | 44.3s | PASS | 15.1s | PASS | Seeded facts (Project-Zeus-77, ZEUS-9922, 8443), context compacted, gist preserved |
| **S5: Beyond budget & resilience** | 420.1s | PASS | 390.4s | PASS | High-context Raft guide, mid-turn steer absorbed, mid-stream reload survived, 21K+ chars |
| **S6: Multi-slice host job** | 54.3s | PASS | 57.3s | PASS | host_write_file + host_read_file + host_run_powershell, verified 74 bytes on disk |
| **S7: Long-generation stability** | 174.9s | PASS | 180.8s | PASS | Deep-dive streaming spec, 17,059 chars (4,265 tokens), status completed, 0 silent drops |
| **S8: Host-mode stress** | 156.9s | PASS | 171.9s | PASS | 70KB host read without clamp, s8-verify.txt written, 75K stdout clamped at 64KB |

**FINAL VERDICT: 8/8 SCENARIOS GREEN — 2/2 CONSECUTIVE RUNS CLEAN — THE BAR ("4K / 100K") ACHIEVED**


---

---

## Host Runner Daemon Death Incident & Recovery (Nov 9, 2026)

### 1. Incident Summary & Root Cause (Grade: PROVEN)
- **Incident:** During the sandbox agent's first self-job (`thread-1794249640310-53v2`), running `cd web-ui; npm run test 2>&1 | Select-Object -Last 15` through the host bridge caused `host-runner.exe` (PID 14612) to disconnect mid-turn (`fetch failed`).
- **Evidence:**
  - `ai-control.log` line 6741 recorded `[2026-11-09 12:46:19] >>> STARTING AI-OFF EXECUTION` and `Terminating Host Runner PID 14612 and its process tree...` via `taskkill.exe /PID 14612 /T /F`.
  - Windows Event Log: 0 application crashes or exceptions (no Event ID 1000/1001). Exit was an external process tree kill.
  - Root Defect: `web-ui/package.json` test script `"test": "tsx --test tests/**/*.test.ts"` ran `web-ui/tests/aiLifecycle.test.ts`. Lines 64-66 invoked `runPowerShell(["-File", AI_OFF_SCRIPT, "-OnlyHostRunner"])`. When executed via the host bridge, `AI-OFF.ps1` discovered its own parent daemon and terminated the process tree.

### 2. Intervention & Minimal Liveness Net
- **Self-Kill Defense (`C:\AI\ai-control\AI-OFF.ps1`):** Implemented `Test-IsDescendantOfProcess`. Refuses self-termination if invoked from a child/descendant process of `host-runner.exe`.
- **Liveness Net (`C:\AI\ai-control\Probe-HostRunner.ps1`):** Added automated daemon probe that detects dead/unresponsive states and relaunches the daemon via WMI (`AI-ON.ps1 -OnlyHostRunner`), logging the resurrection.
- **Provenance Digest:** `48d1d2126b17b8beb64f4c8e262f74b49dc6ad981930d4466b2fe8d93b2894b0` (unchanged).

### 3. Dogfood Proof
- Re-ran the preceding workload through the host bridge (`http://host-runner-service:8765`) from inside the sandbox pod under 30+ seconds of observation.
- `npm run test:gate` passed: 15/15 tests in 1.124s.
- `AI-OFF.ps1 -OnlyHostRunner` called via bridge triggered self-kill defense and exited 0.
- Host Runner PID preserved at 34716 throughout the entire run. Failed host calls: 0. Settings: `runnerState=READY`. Verdict: **PASS**.

### 4. PR #59 Part A Tail & CI Verification
- Uncommitted doc change in `docs/live-coverage.md` committed as `2a51ff9` (`docs: align live-coverage author attribution with brand hygiene standards`).
- GitHub Actions CI Run `42689359274` on PR #59 passed 100% green:
  - `Unit Tests & Static Analysis`: **pass** in 2m57s
  - `Code Coverage Report`: **pass** in 3m6s
  - `Container Build & Docker Scout Scan`: **pass** in 3m31s
  - `Playwright UI Invariants, Flows & Baselines`: **pass** in 3m30s

---

--

## 2026-11-09: RESUME — Part B (Thread Deletion UI & Backend) & Part C (Disarm Lifecycle Test)

### Part B: Resilient Thread Deletion UI & Backend (PR #60)
- PR: https://github.com/ZackMcColgan/local-agentic-sandbox/pull/60
- Backend deletion removes records, artifacts directory, sidecars, cancels real checkpoints, deletes ghost checkpoints, aborts active turns, and prevents resurrection.
- Three UI paths (touch long-press, visible overflow button, keyboard Delete/Enter), single accessible confirm dialog with focus trap, and neutral state transition on active thread delete.
- Gate verified: 177 tests passed in 38.5s. Playwright Flow 5 e2e passing across all 4 viewports.

### Part C: Disarm Lifecycle Test to Live Tier with Hard Guard (PR #61)
- PR: https://github.com/ZackMcColgan/local-agentic-sandbox/pull/61
- Relocated live test out of default suite to web-ui/tests-live/aiLifecycle.live.ts under explicit npm run test:lifecycle script.
- Re-pointed at sacrificial runner on ephemeral port (8799) with isolated temp config directory.
- Hard guard assertSacrificialTarget rejects port 8765 and production paths.
- Default suite backfilled with pure guard tests and mocked environment unit tests.
- Behavioral acceptance verified: production host runner PID remained 34716 throughout test:gate, test:lifecycle, and guard rejection probe.



---

## 2026-11-10: TURN-DELIVERY FIX & CLIENT RECONCILIATION

### Context & Diagnosis Audit
- **Root Cause Verified:** Long chat turns did not die; delivery failed due to the 500ms SSE writer write-race timeout (`[ChatRoute] SSE writer failed for thread ... Turn continuing detached server-side.`). Turn completes detached server-side and persists to thread record, but client was previously left with a terminal error.
- **Defects Addressed:**
  1. Caught SSE writer error was discarded without logging details.
  2. Missing `finish_reason` and token accounting on persisted messages.
  3. Client treated stream disconnect as a terminal error instead of transient state reconciled against server thread.
  4. Zombie 'streaming' messages persisted on interrupted turns.

### Deliverables Implemented & Verified
- **Deliverable 1 (Log the Caught Error):**
  - Updated `web-ui/app/api/chat/route.ts` and `web-ui/lib/turnReconciliation.ts`.
  - Format helper formats caught error name, message, and first stack frame.
  - Verbatim log output: `[ChatRoute] SSE writer failed for thread <id>: Error: writer timeout | at Timeout._onTimeout (...). Turn continuing detached server-side.`
- **Deliverable 2 (Honest Turn Records):**
  - Added `finish_reason?: string` and `outputTokens?: number` to `ThreadMessage` in `web-ui/lib/threads/threadStore.ts`.
  - In `web-ui/app/api/chat/route.ts`, tracked `lastFinishReason` and `turnOutputTokens` across all LLM streaming loops (tool turns and synthesis).
  - Saved `finish_reason` and `outputTokens` at assistant message persist.
  - If `finish_reason` is abnormal (`"length"`, `"error"`, `"abort"`), marked turn status `"incomplete"` and appended honest truncation banner (`⚠️ [Turn incomplete: ... token limit reached]`).
- **Deliverable 3 (Client Reconciliation):**
  - Added pure transition helpers in `web-ui/lib/turnReconciliation.ts` (`transitionOnStreamDisconnect`, `transitionOnDetachedTurnReconciliation`).
  - In `web-ui/components/ChatStream.tsx`, stream disconnect enters a transient state (`data-testid="turn-transient-disconnected"`: `"Connection interrupted — turn continuing server-side..."`), polls `/api/threads/:id` in background until detached turn completes, swaps in persisted full message, and reveals `data-testid="turn-resolved-detached"`.
- **Deliverable 4 (Zombie Reaping):**
  - In `web-ui/lib/threads/threadStore.ts` (`reconcileThread`), any assistant message remaining in `"streaming"` status when `!isLive` is finalized to `"incomplete"`, preserving content and setting `isStopped: true`.
- **500ms Race Threshold:**
  - Kept strictly unchanged at 500ms.

### Test & Verification Evidence
- `web-ui/tests/turnDeliveryReconciliation.test.ts`: 5/5 tests passing.
- `npm run test:gate`: 416 tests passing, 0 failed in 38.779s (<90s budget).
- `npm run build`: Compiled successfully in 10.4s, zero type or lint errors.
- **Branch:** `feature/turn-delivery-reconciliation`
- **Cluster Operations:** 0 operations performed (running re-baselined image `v-2b6262c-fresh`).

---

## CI Job: PR #63 Green Run Log (2026-11-10)

### Step 0 � State Established (read-only gh evidence)
- `gh workflow list --all`: `CI Pipeline & Security Boundary Verification` = **active** (ID 370993482). No workflow disabled_manually or disabled_inactivity.
- `gh api repos/ZackMcColgan/local-agentic-sandbox/actions/permissions`: `{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}` � repo-level Actions enabled.
- `gh run list --limit 15`: runs continue through 2026-11-10T16:47:52Z; last green run was develop push `2b6262c` (PR #62 merge) at 2026-11-09T22:53:50Z.
- `gh pr view 63`: state OPEN, head `feature/turn-delivery-reconciliation` @ `e1f0cb4`, statusCheckRollup = FAILURE on `Unit Tests & Static Analysis` (run 42858208319), downstream jobs SKIPPED.

### Root Cause
Actions was never disabled � no permission or workflow-state stoppage. PR #63's head run failed on one test: `chatThinkingPreservation.test.ts` 1(d) bans keying thinking-panel visibility to `idx === deduplicatedMessages.length - 1` (CHAT-13b invariant), but this PR's new detached-turn notification (ChatStream.tsx:2845) used exactly that fragile tail key, so a steer bubble appended after reconciliation hides the notification.

### Fix (cycle 1, on branch, no test/workflow weakening)
- `web-ui/components/ChatStream.tsx`: added `lastAssistantIndex` (last assistant message index over `deduplicatedMessages`) and keyed `hasResolvedDetachedTurn` notification to `idx === lastAssistantIndex` instead of the literal tail.
- Local verification: `npx tsx --test tests/chatThinkingPreservation.test.ts` 4/4 pass; root `npm test` full suite 1027 pass / 0 fail.

### Fix Cycle 2 (Playwright job, run 42862508213)
- Run 42862508213 (head 997b916): Unit Tests, Coverage, Container Build all green; Playwright job failed 8 tests (Scenario 7 engine-stop, Scenario 9 backend-down across 4 viewports).
- Root cause: Deliverable 3 routed ALL mid-turn errors into the transient detached-reconciliation state, so the terminal error banner (errorMsg + Retry) never rendered. Log evidence: ChatRoute 'Client SSE connection disconnected... Turn continuing detached server-side' then 'Detached turn completed' � UI showed transient/resolved banner instead of 'Local LLM Engine offline' / 'Service Unavailable' surfaces.
- Fix (no test weakening): ChatStream.tsx � SSE 'error' events and non-ok HTTP responses now throw errors tagged isTerminalServerError; transient reconciliation only entered for genuine client disconnects on real, non-simulated threads. Terminal errors keep errorMsg banner + Retry.
- Local verification: playwright scenarios 7/9 pass 8/8 across mobile-light/dark, desktop-light/dark; root npm test full suite 1027 pass / 0 fail; next build clean.

## Steer run � synthesis-retry merge+deploy job (Phase 1 Step 1) � STOPPED, PR NOT FOUND
- gh pr list --state open --json ... => [] (zero open PRs on ZackMcColgan/local-agentic-sandbox).
- gh pr list --state all --limit 100 grep 'synthesis' => no match; merged list top = PR #63 (feature/turn-delivery-reconciliation, merged 2026-11-10T19:54:40Z, merge commit 18282cb).
- git ls-remote origin => no remote branch feature/synthesis-retry.
- Local branch feature/synthesis-retry tip = 18282cb0d7ea (== origin/develop tip); git rev-list --count origin/develop..feature/synthesis-retry = 0 commits ahead.
- Fix content exists ONLY untracked: web-ui/tests/synthesisRetry.test.ts (untracked). git diff origin/develop -- web-ui/app/api/chat/route.ts = EMPTY (no retry logic in route.ts; route.ts:1632 still the bare 'concluded without synthesis text' stamp, no synthesis retry at ~1554-1607). git grep synthesisRetry in package.json/scripts = no testGate wiring.
- Conclusion: no PR to merge (owner did NOT merge it himself � develop does not contain the synthesis-retry change). Per Step 1 requirement ('if any of that differs, STOP and report'), Phase 1 Steps 2-6 NOT executed; production untouched; no build, no import, no kubectl set image.

## Steer run - synthesis-retry apply+commit+PR job (recovery)
- STATE CHECK: branch feature/synthesis-retry tip 18282cb0d7ea == origin/develop; route.ts synthesis block unfixed (bare stamp at 1632); tests/synthesisRetry.test.ts present untracked and matches the design (scripted-stream POST, 4 completions: tool round -> empty round -> empty synthesis -> retry summary; plus a double-empty case).
- APPLY: route.ts synthesis block replaced with runSynthesisPass() (single pass streamed into shared accumulators); retry fires once when pass 1 returns no content, emitting status "Synthesis returned no text - retrying once..."; audit fold-in (a) pass-1 thinking pushed into accumulatedThoughts BEFORE the retry overwrites it; audit fold-in (b) synthSpan ends "empty-synthesis" on the double-empty path instead of unconditional "ok". synthContent/synthThinking locals removed (replaced by passContent/passThinking inside runSynthesisPass). Stamp at turn-end now appends "Work persisted above; the summary failed. The thread is resumable - resume this thread to continue." preserving the original substring exactly (hoisted as EMPTY_SYNTHESIS_STAMP).
- FIX-ITERATION NOTE: first pass left the double-empty turn reporting status=completed because the generic "I am ready to assist you..." fallback filled cleanedContent, so the !cleanedContent branch never ran. Added a hoisted synthesisReturnedEmpty flag + final honest override so a failed synthesis always marks the turn incomplete.
- GATE WIRING: web-ui/lib/testGate.ts chat-route mapping group (match app/api/chat/route) now includes tests/synthesisRetry.test.ts.
- PASS-AFTER: npx tsx --test tests/synthesisRetry.test.ts -> 2 pass / 0 fail (retry summary persisted, status completed, retry status event present; double-empty -> status incomplete + resumable stamp).
- test:gate: repo-wide git-status scan rejects on unrelated untracked web-ui/app/api/settings/memory/route.ts (zero coverage) - unrelated Settings Memory work, NOT this job. Scoped run node scripts/test-gate.js --files=web-ui/app/api/chat/route.ts,web-ui/lib/testGate.ts -> PASSED 179 pass / 0 fail / 1 skipped in 37.87s (<90s budget).
- STAGED ONLY: web-ui/app/api/chat/route.ts, web-ui/tests/synthesisRetry.test.ts, web-ui/lib/testGate.ts, docs/queue-steer-runlog.md. Settings Memory files (lib/memory/operatorMemory.ts, app/api/settings/memory/, operatorMemory/operatorMemoryInjection/settingsMemoryUi tests) left untracked and untouched.
- NO merge, NO deploy this job.

## Fix cycle - PR #64 CI (run 42925509474, head 5f4c7b7)
- RE-GROUND: HEAD 5f4c7b7 == origin/feature/synthesis-retry; no uncommitted tracked changes. Untracked tree inventory (NOT part of this job, left untouched): Settings Memory work (web-ui/app/api/settings/memory/, lib/memory/operatorMemory.ts, operatorMemory/operatorMemoryInjection/settingsMemoryUi tests) + stranded-turn scratch (.tmp-forensics.py, .tmp-pr-body.md, .tmp-synth-guard.js, .tmp-synth-override.js, .tmp-synth-patch.js, .tmp-synth-scope.js, .tmp-thread.json, .tmp-thread2.json, web-ui/tests/.tmp-synth-debug.test.ts). No candidate fix in the tree relevant to the CI failure.
- DIAGNOSE (gh run view 42925509474 --log-failed): Job 'Unit Tests & Static Analysis', step 'Typecheck & Build Services' (npm run build --workspaces). Exact error: ./app/api/chat/route.ts:1632:27 - Type error: Argument of type '"empty-synthesis"' is not assignable to parameter of type '"error" | "ok" | undefined'. The route's own tracer (web-ui/lib/telemetry.ts:102,128 - TelemetryTracer.startSpan/end) constrains span status to "ok"|"error"; supervisor.ts's two-arg end(status,{attrs}) form is fine, but the status literal itself must be ok/error.
- FIX (no guard edit, no assertion change): route.ts:1632 synthSpan.end("empty-synthesis", { synthesisPasses }) -> synthSpan.end("error", { synthesisPasses, emptySynthesis: true }). Intent preserved: the synthesis span still ends non-ok on the double-empty path, with the empty-synthesis signal carried as an attribute. No test asserts on span status/attrs (git grep: synthesisPasses/model.synthesis absent from tests).
- LOCAL VERIFY: npx tsx --test tests/synthesisRetry.test.ts -> 2 pass / 0 fail. npx next build -> exit 0 (typecheck clean; the failing CI step is next build, which now passes locally).
- PUSH + watch new run below.
- WATCH PARTIAL (run 42930341188, head c1a9f1f): Unit Tests & Static Analysis = success (Typecheck & Build Services now passes; Execute Full Test Suite success). Playwright, Container Build, Coverage still in_progress at poll time. Host runner disconnected during gh run watch; recovered via gh run view --json poll. Continuing polls to full green.

## CI Watch close-out - PR #64 FULLY GREEN (2026-11-11)
- RUN 42930341188 (head c1a9f1f): status completed, conclusion success. All four jobs success:
  Unit Tests & Static Analysis = success (2m33s, job 130227195885)
  Playwright UI Invariants, Flows & Baselines = success (3m29s, job 130228340343)
  Container Build & Docker Scout Scan = success (3m36s, job 130228340395)
  Code Coverage Report = success (3m11s, job 130228340413)
- SUPERSESSION: run 42931144092 exists for feature/synthesis-retry on head 9fca81e (docs-only runlog commit, no code change). Watched the newest run per rule 4: status completed, conclusion success, all four jobs success:
  Unit Tests & Static Analysis = success (job 130229898485)
  Playwright UI Invariants, Flows & Baselines = success (job 130231147851)
  Container Build & Docker Scout Scan = success (job 130231147933)
  Code Coverage Report = success (job 130231147992)
- gh pr checks 64: all four checks pass on the newest run. Prior failure run 42925509474 (head 5f4c7b7) superseded by the typecheck fix c1a9f1f.
- No merge, no deploy this job - those arrive as separate tickets.
- WATCH FULL GREEN (run 42930341188, head c1a9f1f): Unit Tests & Static Analysis success; Playwright UI Invariants success; Container Build & Docker Scout Scan success; Code Coverage Report success; run conclusion success. Runlog-only push 9fca81e also triggered run 42931144092 -> all four jobs success, run conclusion success. NO merge, NO deploy.

## Deploy ticket PR #64 -> prod (2026-11-11)
- Develop head confirmed: 6e02172fa905ad73bcf43a801a22e48f558297fa ("Merge pull request #64 from ZackMcColgan/feature/synthesis-retry", PR head 8622a0d, CI run 42932489987 all-four-green).
- ROLLBACK TARGET (current prod image, captured BEFORE build): local-agentic-sandbox-web-ui:v-18282cb-fresh (deployment web-ui, namespace local-agentic-sandbox; pod web-ui-6c858f8565-4g8g9 1/1 Running).
- Target image tag to build: local-agentic-sandbox-web-ui:v-6e02172-fresh. Deploy scope: web-ui only.
- Build complete: docker build -t local-agentic-sandbox-web-ui:v-6e02172-fresh -f web-ui/Dockerfile . -> image de07c9232d01 (327MB disk / 78MB content). Cached layers reused.
- Transfer per scripts/deploy-cluster.js flow: docker save temp-web-ui-6e02172.tar -> docker cp to desktop-control-plane:/images/image.tar -> ctr -n k8s.io images import (sha256:de07c9232d01..., imported OK) -> node-side /images/image.tar removed. Host-side temp tar left pending host-approval cleanup (harmless artifact).

## Settings Memory job (2026-11-12) — resume, implementation landed
- Fail-before re-verified on branch feature/settings-memory (rebased onto develop ac4ba03): 19 pass / 6 fail (5 UI + 1 injection wiring).
- Inventory: lib/memory/operatorMemory.ts, app/api/settings/memory/route.ts, and the three test files already existed untracked; chat route, SettingsView card, .gitignore pattern, repoHygiene guard, and testGate wiring were missing.
- Implemented: chat route OWNER MEMORY injection via assembleSystemPrompt (byte-identical when memory empty); SettingsView Memory card (textarea, live counter, save blocked beyond 2000 cap, exact privacy note); .gitignore operator-memory.json pattern; repoHygiene tracked-file guard; testGate mapping rules only (pass/fail logic untouched).
- Two test-side fixes during green-up: operatorMemory.test.ts cleanup moved into an after() hook (suite-level delete of OPERATOR_MEMORY_PATH ran before async subtests, leaking writes into the default store); SettingsView counter counts non-whitespace characters per the UI test spec, and textarea listens for native input events.
- npm run test:gate: PASSED 162 pass / 0 fail, 26.1s (<90s budget). Ships EMPTY - no memory content seeded.

## Settings Memory PR #65 -> develop (2026-11-12)
- Branch feature/settings-memory head 0ed4d62 (one commit on develop ac4ba03); pushed; PR #65 opened into develop. No merge, no deploy this job.
- Gate evidence on clean branch: npm run test:gate PASSED 328 pass / 0 fail, 40.1s (<90s budget).
- Acceptance: git check-ignore -v shows .gitignore:62 (.agent/) and .gitignore:65 (operator-memory.json) cover the store; git ls-files | grep operator-memory = zero matches. Ships EMPTY - owner seeds his own facts later.
- Unrelated compaction WIP preserved: branch feature/compaction-hybrid restored to 9df7762; working-tree compaction edits stashed ("compaction-hybrid WIP preserved").

## Deploy ticket PR #65 settings-memory -> prod (2026-11-11)
- PR #65 merged into develop by driver (audit PASS: scope 11 files exact; exact OWNER MEMORY header; byte-identical empty prompt; card counter/cap/exact note; .gitignore + repoHygiene guard; testGate mapping-only; no brand names; acceptance evidence in PR body). Merge commit e36f1b4; CI run 42955669440 all-four-green on head c5f50b1 (Unit Tests 2m49s, Coverage 2m52s, Container Build 4m3s, Playwright 3m31s).
- ROLLBACK TARGET (current prod image, captured BEFORE build): local-agentic-sandbox-web-ui:v-6e02172-fresh (deployment web-ui, namespace local-agentic-sandbox; pod web-ui-76847586c6-n872c 1/1 Running 0 restarts).
- Target image tag to build: local-agentic-sandbox-web-ui:v-e36f1b4-fresh. Deploy scope: web-ui only.
- DEPLOY OUTCOME (driver, 2026-11-11 ~22:20 CT): PROD == develop c5389f6 VERIFIED. S1 runlog commit c5389f6 pushed first (tag then v-c5389f6-fresh). S2 build BLOCKED at first by Docker credential helper: `node:22-alpine` not in the daemon image store, and `docker-credential-desktop` fails in non-interactive SSH logons ("A specified logon session does not exist"); DOCKER_CONFIG override to an empty config did NOT bypass it (CLI still invoked the helper). WORKAROUND (SSH-side, durable): pull the base into the kind node with `ctr -n k8s.io images pull docker.io/library/node:22-alpine` (anonymous, no Windows helper), `ctr images export` to /images/node-22-alpine.tar, `docker cp` out, `docker load` into the daemon. SSH sessions also DROP after ~30-45s on long foreground commands (two broken pipes during the build); processes with stdout redirected to a log file SURVIVE the drop and keep running — poll the log + `docker images` with short calls instead of holding the session. Build then green (Next.js build ~2.5min, image 7e3099c05682); save 78MB tar; ctr import OK (node image 8ab5e734216df). S3 set image v-c5389f6-fresh. S4 rollout success, new pod web-ui-6b6fb6d557-765sz 1/1 Running 0 restarts; gateway 200; /api/threads 12 threads intact; UI render check clean (nav + threads list, screen matches record). ROLLBACK TARGET remains v-6e02172-fresh. LESSON for future deploys: if `node:22-alpine` is missing from the daemon store, use the ctr-export/docker-load path above before building; keep long builds log-redirected and poll.

## Settings Memory DONE + compaction-hybrid resumes (2026-11-11)
- Settings-memory item DONE 2026-11-11 ~22:20 CT: PR #65 audit PASS (driver) → merged e36f1b4 → deployed v-c5389f6-fresh → verified prod == develop c5389f6 (rollout success, pod 1/1 Running 0 restarts, gateway 200, 12 threads intact, UI render clean). Prod SHA now c5389f6; rollback target v-6e02172-fresh.
- Compaction-hybrid continuation brief issued 2026-11-11 ~22:24 CT in fresh thread thread-1794371021984-comphyb2 (model qwen3.8-flash-next-gyro-gyro-s, medium): CONTINUE from banked 9df7762 on origin/feature/compaction-hybrid (9 tests red, implementation partial; no PR yet); brief instructs stash inspection, fail-before re-confirmation, guardrail tests, COMPACTION_PROMPT_V1 verbatim, gate, PR into develop, no merge/deploy in-job. Strike count stays 1 (first turn stranded once).
- compaction-hybrid 2a: digest-index fix in conversationCompaction.ts (digestIndex = leading system ? 1 : 0) at read sites + hybrid write; hybridCompaction.test.ts now 7/9 (test 5 green; 8-9 await store rung 2b).
## compaction-hybrid 3: route wiring (2026-11-12)
- ROUTE WIRING: web-ui/app/api/chat/route.ts in-turn ladder call-site (~L827) now branches on resolveCompactionStrategy(): COMPACTION_STRATEGY=hybrid awaits threadStore.compactThreadIncrementalHybrid(threadData, { summarize }) with a call-site adapter (system=req.prompt verbatim, user=req.digest, signal=req.signal, options temperature/num_predict, finish_reason=length -> truncated); unset/anything-else keeps the existing synchronous compactThreadIncremental(threadData) call byte-identical. Summarization pass, identifier post-check, deadlines, fallback untouched (live in the rung). web-ui/app/api/threads/[id]/compact/route.ts left on extraction (out of scope).
- TEST: hybridCompaction.test.ts seam test added (source-level call-site selection: strategy branch, awaited hybrid rung, else extraction call, adapter contract, compact endpoint stays extraction). FAIL-BEFORE proven: route.ts stashed to HEAD 3fedd43 -> 9 pass / 1 fail ("call-site must branch on the resolved strategy"). PASS-AFTER: npx tsx --test tests/hybridCompaction.test.ts -> 10 pass / 0 fail.
- TYPECHECK: npx tsc --noEmit error set identical to HEAD baseline (pre-existing: operatorMemory import unresolved on this branch base ac4ba03, resolved when PR lands on develop; test-file strictness errors pre-existing). No new errors from this step.
- STEP 4 REMAINING: npm run test:gate + PR into develop (driver owns merge/deploy).
