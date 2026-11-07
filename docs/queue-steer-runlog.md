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

