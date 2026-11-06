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
  - `web-ui/tests/presence-debug3.ts`, `presence-debug4.ts`
- Worktree is clean.
- Existing stashes:
  - `stash@{0}`: `track-u-wip`
  - `stash@{1}`: `scheduler WIP`
  - `stash@{2}`: `local-ai-mess-backup`
  None are discarded or altered.

### Host Bridge Status
- `GET http://127.0.0.1:8765/health` -> HTTP 200 OK
  `{"status":"ok","protocolVersion":1,"bridgeSourceSha256":"63397ac9d1c3fabfe1af150343898834c4ba1a1ec96211192f5b2a8011f271bd","pid":22352}`

---

## Phase 1 — Diagnosis (INV-A & INV-B)
*In Progress...*
