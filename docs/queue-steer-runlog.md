# Chat Runtime Shakeout: Queue + Steer Run Log

**Date:** 2026-11-06  
**Agent:** Antigravity  
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

## Phase 6 — Completion & PR Summary
- Single PR created from `feature/chat-queue-steer` into `develop` (DO NOT MERGE).
- All gates green, zero new dependencies, strict platform boundaries respected.
