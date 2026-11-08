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
