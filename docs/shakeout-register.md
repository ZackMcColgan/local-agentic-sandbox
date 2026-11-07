# End-to-End Shakeout Bug Register

**Date:** 2026-10-24  
**Amended:** 2026-10-28 — retro-registered omissions: P0-A and P0-B were in the Oct 24 shakeout scope but were never entered below. Documentation-only amendment; no fixes included.  
**Amended:** 2026-11-01 — status truth-up & closure (Part B register sweep: P0-1, P0-2, P0-3, P1-1, P1-2, P2-1 verified fixed in commit bfb8e2c; P0-A, P0-B design blocked; P0-6, P1-3 fixed via PR #38 commit 5cfe158).  
**Scope:** Deployed cluster (`http://127.0.0.1:3001` and `http://192.168.50.254:80`), real LLM engine (`Swift-1.5-Qwen3.8-27B-IQ3_XS`), real git repository, real workspace persistent volume.  
**Branch:** `feature/projects-and-folders` (PR #35).

---

## Register Metric
- **Total Defects Identified:** 13
- **P0 Defects (Blocks Core Use):** 6
- **P1 Defects (Degraded Functionality):** 5
- **P2 Defects (Minor / Polish):** 2

---

## Defect Inventory & Register

### [P0-1] Build Mode Spins Forever Without Terminal State or Error Display
- **Feature:** Build Mode / Task Execution Lifecycle
- **Affected Components:**
  - `web-ui/lib/llm/provider.ts` (`LlamaCppProvider.generate`)
  - `web-ui/app/page.tsx` (`handleLaunchTask`)
  - `web-ui/app/api/threads/route.ts` (`action: "launchTask"`)
  - `web-ui/lib/subagents/supervisor.ts` (`executeTaskWithRecovery`)
  - `web-ui/app/api/tasks/route.ts` (`GET /api/tasks?active=true`)
- **Steps to Reproduce:**
  1. Open the web UI at `http://192.168.50.254/` (or `http://localhost:3001/`).
  2. Switch composer mode to **Build**.
  3. Submit a goal requiring milestone decomposition (e.g. `Add a new helper function formatIsoDate to utils.ts with unit tests`).
  4. Observe the UI state and console.
- **Expected Behavior:**
  The planner decomposes the goal with adequate token budget; milestones stream in `LiveRunBlock`. If planning or execution encounters a failure (timeout, model unavailability, syntax error), the task terminates cleanly into `failed` or `parked` state, displays an explicit error message/banner, posts a failure notification in the thread, and reverts the composer to Send.
- **Actual Behavior:**
  1. `LlamaCppProvider.generate` caps `max_tokens` at 2048 without allocating a separate thinking token budget. Qwen3.8 spends 1600+ tokens in reasoning, exhausting available tokens before completing JSON output.
  2. `JSON.parse` crashes with `Unexpected end of JSON input`, returning HTTP 500 from `POST /api/threads`.
  3. `handleLaunchTask` in `page.tsx` ignores non-200 responses and fails to display an error or rethrow, causing the composer prompt to clear while nothing starts.
  4. When an asynchronous task fails mid-milestone in `supervisor.executeTaskWithRecovery`, `currentThread.status` remains `"active"`, no failure message is posted, and disk checkpoints remain `"active"`.
  5. `GET /api/tasks?active=true` finds the orphaned active task, causing the UI spinner to spin indefinitely without ever reaching a terminal state.
- **Evidence:**
  - Pod log excerpt: `STATUS: 500 BODY: {"error":"Model \"Swift-1.5-Qwen3.8-27B-IQ3_XS\" unavailable at http://llm-service:11434: Model \"Swift-1.5-Qwen3.8-27B-IQ3_XS\" unavailable at http://llm-service:11434/v1/chat/completions: empty response"}`
  - Pod log excerpt: `FATAL for milestone M1: ModelUnavailableError: Model "swift-15-27b-mtp" unavailable at http://llm-service:11434: Model "swift-15-27b-mtp" unavailable at http://llm-service:11434/v1/chat/completions: empty response`
  - Probe log: `HTTP 500: {"error":"Unexpected end of JSON input"}` in `web-ui/lib/subagents/planner.ts:307`.
- **Severity:** **P0** (Blocks core Build mode feature; causes infinite spinner).
- **Status:** **VERIFIED-FIXED** (2026-11-01; resolved in historical commit bfb8e2c by allocating 4096 thinking token budget headroom in LlamaCppProvider, content recovery from reasoning chunks, error display in page.tsx, and parked terminal states; verified by unit tests in shakeoutFixes.test.ts and successful in-pod execution).

---

### [P0-2] Workspace Git Permissions Denied in Kubernetes Container
- **Feature:** GitOps / Workspace Branch Isolation
- **Affected Components:**
  - `web-ui/lib/subagents/workerGitOps.ts`
  - `web-ui/lib/subagents/supervisor.ts`
  - Kubernetes volume permissions on `/workspace/.git`
- **Steps to Reproduce:**
  1. Trigger any task that executes git commands inside the deployed `web-ui` pod (e.g. creating a task branch or committing a milestone deliverable).
  2. Inspect pod logs via `kubectl logs deployment/web-ui -n local-agentic-sandbox`.
- **Expected Behavior:**
  `WorkerGitOps` creates and switches to `feat/task-<id>`, commits milestone deliverables, and resolves real git SHAs.
- **Actual Behavior:**
  `git` fails with `fatal: Unable to create '/workspace/.git/index.lock': Permission denied`.
  The `/workspace/.git` directory on the persistent volume is owned by `10001:10001` with `drwxr-xr-x`, but `web-ui` runs as `nextjs:nodejs` (UID `1001:1001`). Because branch switching fails, execution remains on `main`, where `WorkerGitOps` blocks commits (`cannot commit directly to protected branch: main`), causing all git operations to fail.
- **Evidence:**
  - Pod log excerpt: `[supervisor] GitOps branch switch warning: Failed to create/switch branch feat/task-179282164009: fatal: Unable to create '/workspace/.git/index.lock': Permission denied`
  - Pod log excerpt: `[supervisor] Git stage/commit failed for milestone M1 (file: hello.js): Command failed: git add hello.js`
  - Pod log excerpt: `[supervisor] GitOps milestone commit warning: WorkerGitOps cannot commit directly to protected branch: main`
  - `ls -la /workspace`: `drwxr-xr-x 7 10001 10001 4096 Oct 23 07:01 .git` vs process running as UID 1001.
- **Severity:** **P0** (Blocks git tracking, branch isolation, and milestone commits in production container).
- **Status:** **VERIFIED-FIXED** (2026-11-01; resolved in historical commit bfb8e2c by configuring pod securityContext with fsGroup: 1001 and supplementalGroups: [10001] in deploy/k8s/web-ui.yaml; verified live in web-ui pod where git branch creation and commits operate with exit code 0 under non-root user 1001:1001).

---

### [P0-3] Stale Task Rehydration Prevents Fresh Tasks from Displaying
- **Feature:** Task State Hydration & Task Polling
- **Affected Components:**
  - `web-ui/app/api/tasks/route.ts` (`GET /api/tasks`)
- **Steps to Reproduce:**
  1. A task crashes or the container restarts while a task is marked `status: "active"` on disk.
  2. Trigger a new task or query `GET /api/tasks?active=true`.
- **Expected Behavior:**
  Stale, abandoned tasks that have no active in-memory worker and have not updated within a threshold (e.g. >10 minutes) are marked `parked` or `failed`. The most recently active task is returned.
- **Actual Behavior:**
  `GET /api/tasks` iterates through all disk checkpoints and rehydrates any task whose disk status is `"active"`. `list.find(t => t.status === "active")` returns the oldest stale crashed task instead of newly created tasks, trapping the frontend poller in the abandoned task's state.
- **Evidence:**
  - Code inspection in `web-ui/app/api/tasks/route.ts`:
    ```ts
    const activeTask = list.find((t) => t.status === "active") || list[0] || null;
    ```
- **Severity:** **P0** (Corrupts task polling; masks new task runs).
- **Status:** **VERIFIED-FIXED** (2026-11-01; resolved in historical commit bfb8e2c in web-ui/app/api/tasks/route.ts by auto-parking orphaned disk tasks with status active older than 5 minutes without in-memory execution; fresh tasks sort and surface by updatedAt desc; verified by unit tests and code inspection).

---

### [P0-A] Session Durability Lost on Cluster Updates / Redeploys
- **Feature:** Session Durability / Cluster Lifecycle
- **Affected Components:** not recorded
- **Steps to Reproduce:**
  1. Start an in-progress session on the deployed cluster.
  2. Update or redeploy the stack.
  3. Observe the session after the update/redeploy.
- **Expected Behavior:** In-progress sessions remain durable across cluster updates and redeploys.
- **Actual Behavior:** When the stack updates or redeploys, in-progress sessions are lost.
- **Evidence:** not recorded
- **Severity:** **P0** (Blocks core use; session continuity lost on every update/redeploy).
- **Status:** **FIXED** (2026-11-01; commit f6f7e56 in web-ui/lib/threads/threadStore.ts resolving THREADS_DIR to persistent volume mount /workspace/.agent/threads and configuring THREADS_DIR in deploy/k8s/web-ui.yaml; verified live across 2 consecutive pod redeploy/rollout cycles with in-progress thread and message state intact and fully resumable).

---

### [P0-B] User Message Vanishes After Model Finishes Thinking
- **Feature:** Message Persistence & Reload Integrity
- **Affected Components:** not recorded
- **Steps to Reproduce:**
  1. Send a user message that triggers model thinking.
  2. Wait for the model to finish thinking.
  3. Observe the message, then reload the thread.
- **Expected Behavior:** The user message remains present after thinking completes and returns on reload.
- **Actual Behavior:** A user message can disappear after the model finishes thinking and does not return on reload. Shakeout triage determined this is a persistence failure (the message is not durably stored), not a rendering bug.
- **Evidence:** not recorded
- **Severity:** **P0** (Blocks core use; corrupts conversation history).
- **Status:** **FIXED** (2026-11-01; commit 561ed84 in web-ui/components/ChatStream.tsx awaiting user message persistence before streaming turn dispatch, atomic temp-file rename in ThreadStore.saveThread, and message deduplication in app/api/threads/[id]/route.ts; verified live across 10/10 consecutive trials of send-with-thinking -> turn completion -> message reload integrity).

---

### [P1-1] Synchronous Schedule Trigger HTTP Timeout
- **Feature:** Scheduler & Automation
- **Affected Components:**
  - `web-ui/app/api/schedules/[id]/trigger/route.ts`
  - `web-ui/lib/subagents/scheduler.ts`
- **Steps to Reproduce:**
  1. Create a recurring schedule via `POST /api/schedules`.
  2. Trigger execution immediately via `POST /api/schedules/:id/trigger`.
- **Expected Behavior:**
  The trigger endpoint starts the scheduled task asynchronously, returns `202 Accepted` or `200 OK` with `{ runId, status: "active" }` immediately, and lets the client monitor status via `/api/tasks`.
- **Actual Behavior:**
  `POST /api/schedules/:id/trigger` awaits the entire multi-milestone task synchronously. Node.js and proxy timeouts abort the connection (`UND_ERR_HEADERS_TIMEOUT` after 5 minutes). Additionally, branch names generated as `sched/<id>` violate the repo branch convention (`feat/`, `feature/`, `fix/`).
- **Evidence:**
  - Probe error: `UND_ERR_HEADERS_TIMEOUT` on `POST /api/schedules/sched-.../trigger`.
  - Pod log: `[supervisor] GitOps branch switch warning: Invalid worker branch name 'sched/sched-1792822037772-2z8cb'. Must follow feat/<slug>, feature/<slug> or fix/<slug> convention.`
- **Severity:** **P1** (Scheduled tasks trigger in background, but HTTP API times out and branch naming fails convention).
- **Status:** **VERIFIED-FIXED** (2026-11-01; resolved in historical commit bfb8e2c by making POST /api/schedules/:id/trigger asynchronous returning 200 OK with runId immediately under 60ms, and sanitizing branch names via sanitizeScheduleBranchName to feat/sched-<id>; verified live on cluster where trigger returned in 54ms and branch feat/sched-1792822037772-2z8cb was created).

---

### [P1-2] Inflexible Planner JSON Parsing on Truncated Responses
- **Feature:** Autonomous Planner Milestone Generation
- **Affected Components:**
  - `web-ui/lib/subagents/planner.ts` (`generatePlanSpec`)
- **Steps to Reproduce:**
  1. Trigger planning on a large prompt where the model emits partial JSON with unclosed brackets or trailing commas.
- **Expected Behavior:**
  The planner repairs minor JSON syntax errors, recovers complete milestones, or falls back gracefully without returning HTTP 500.
- **Actual Behavior:**
  `JSON.parse(stripCodeFence(res.text))` throws an unhandled `SyntaxError`, completely aborting thread and task creation.
- **Evidence:**
  - Probe error: `HTTP 500: {"error":"Unexpected end of JSON input"}`.
- **Severity:** **P1** (Causes avoidable planning failures on borderline token lengths).
- **Status:** **VERIFIED-FIXED** (2026-11-01; resolved in historical commit bfb8e2c in web-ui/lib/subagents/planner.ts via repairAndParsePlanJson which repairs unclosed brackets, missing braces, and trailing commas; verified by unit tests in web-ui/tests/shakeoutFixes.test.ts).

---

### [P2-1] Project Registration Root Path Alias Support
- **Feature:** Projects & Folders API
- **Affected Components:**
  - `web-ui/app/api/projects/route.ts`
- **Steps to Reproduce:**
  1. Send `POST /api/projects` with `{ name: "test", path: "/workspace/projects/test" }`.
- **Expected Behavior:**
  Accepts either `rootPath` or `path` as the project directory.
- **Actual Behavior:**
  Rejects with `400 Bad Request: Project rootPath is required`.
- **Evidence:**
  - Probe output: `HTTP 400: {"error":"Project rootPath is required"}`.
- **Severity:** **P2** (API parameter naming strictness).
- **Status:** **VERIFIED-FIXED** (2026-11-01; resolved in historical commit bfb8e2c in web-ui/app/api/projects/route.ts by accepting rootPath = body.rootPath || body.path; verified live where POST /api/projects with path alias returns 400 Path does not exist rather than rootPath is required, and 400 Project rootPath is required when neither is provided).


---

### [P0-6] Browser MCP Pod Scaled to Zero / Tool Unregistered Execution Failure
- **Feature:** Chat Mode / Web Research & Grounding Toolchain
- **Affected Components:**
  - Kubernetes cluster deployment `deployment.apps/browser-mcp`
  - `web-ui/app/api/chat/route.ts` (`connectMcpClient`, tool registry, and tool execution loop)
- **Steps to Reproduce:**
  1. Open chat UI on mobile or desktop (`http://192.168.50.254` or `http://localhost:3001`).
  2. In Chat mode, ask: *"What's the weather today in Spanish Fort AL?"*
  3. Observe model reasoning and subsequent UI error banner.
- **Expected Behavior:**
  1. `browser-mcp` is deployed with `replicas: 1` and reachable at `http://browser-mcp:8081/sse`.
  2. Tools `search_web` and `fetch_webpage_markdown` are registered in `toolClientMap`.
  3. The model calls `search_web`, fetches current forecast data, and answers conversationally.
  4. If an advertised tool's client is temporarily unreachable, the route returns an informative tool status rather than throwing an unhandled exception that breaks the turn with a red banner.
- **Actual Behavior:**
  1. `browser-mcp` was left scaled to 0 replicas in Kubernetes namespace `local-agentic-sandbox`, leaving `service/browser-mcp:8081` with no endpoints.
  2. `connectMcpClient(BROWSER_MCP_URL)` timed out after 10s, leaving `toolClientMap` with zero browser tools.
  3. When the model invoked `search_web`, `route.ts` threw: `Model attempted execution of unregistered tool: search_web`.
  4. The UI rendered a red error banner with a Retry button and no answer was generated.
- **Evidence:**
  - Cluster status: `deployment.apps/browser-mcp` had 0 desired / 0 ready replicas; `service/browser-mcp` had `Endpoints: <none>`.
  - Web UI pod logs: `[Orchestrator] Could not connect to MCP at http://browser-mcp:8081/sse: SSE error: TypeError: fetch failed: Connect Timeout Error (attempted address: browser-mcp:8081, timeout: 10000ms)`.
  - Browser-MCP pod rebuild and deploy: Rebuilt with multi-session SSE transport fix and scaled to 1 replica (`browser-mcp-66fbf86d65-8zczw` Running).
  - Graceful degradation implemented in `web-ui/app/api/chat/route.ts` via `ADVERTISED_TOOLS` set.
- **Resolution:**
  - Scaled `browser-mcp` deployment to 1 replica and ensured current image is active.
  - Added graceful fallback in `web-ui/app/api/chat/route.ts` so that advertised tools whose client is disconnected return an in-turn tool explanation instead of crashing the turn.
  - Verified live: Query *"What is the weather today in Spanish Fort AL?"* invokes `search_web`, fetches AccuWeather forecast, and streams full markdown answer with 200 OK.
- **Severity:** **P0** (Blocks core live web research tool invocations in Chat mode).
- **Status:** **FIXED** (via PR #38 commit 5cfe158; verified live Nov 1, 2026; merge into develop pending owner's word).

---

### [P1-3] Chat Model Identity Mislabel & Default Model Fallthrough
- **Feature:** Chat Model Routing & UI Active Model Badge
- **Affected Components:**
  - `web-ui/config/models.ts` (`PRESET_MODEL_PROFILES`, `isReasoningEffortSupported`)
  - `web-ui/components/ChatStream.tsx` (`shortModelLabel`)
  - `web-ui/app/api/chat/route.ts` (`DEFAULT_MODEL`, model routing fallback)
- **Steps to Reproduce:**
  1. Open Chat mode in web UI with active engine served via Strata (`MODEL_NAME=qwen3.8-flash-next-gyro-gyro-s`).
  2. Inspect the model chip at the top of the chat view.
- **Expected Behavior:**
  1. The model chip displays **Flash-Next** to reflect the active serving Strata model.
  2. Outbound chat API requests resolve `activeModel` to the configured `MODEL_NAME` (`qwen3.8-flash-next-gyro-gyro-s`) without falling back to legacy swift strings.
- **Actual Behavior:**
  1. `ChatStream.tsx` model label formatter checked `modelSafe.includes("qwen")` before recognizing Flash-Next / Gyro, reducing `qwen3.8-flash-next-gyro-gyro-s` to `"Qwen3.8"`.
  2. `route.ts` defaulted `activeModel = DEFAULT_PRIMARY_MODEL` (`"Swift-1.5-Qwen3.8-27B-IQ3_XS"`) when `activeModel` was `"auto"` or unset, rather than honoring `process.env.MODEL_NAME`.
  3. `config/models.ts` lacked a profile for `qwen3.8-flash-next-gyro-gyro-s`.
- **Evidence:**
  - Owner phone screenshot showed model chip reading `"Qwen3.8"`.
  - `ChatStream.tsx:858` mapped any string containing `"qwen"` to `"Qwen3.8"`.
- **Resolution:**
  - Added `qwen3.8-flash-next-gyro-gyro-s` profile to `PRESET_MODEL_PROFILES` in `web-ui/config/models.ts`.
  - Updated `shortModelLabel` in `ChatStream.tsx` to format `flash-next` and `gyro` as `"Flash-Next"`.
  - Updated `route.ts` to use `DEFAULT_MODEL` (honoring `MODEL_NAME`) for auto and legacy swift defaults.
  - Verified live: Model chip and stream metadata show `qwen3.8-flash-next-gyro-gyro-s` / `"Flash-Next"`.
- **Severity:** **P1** (Inaccurate model display identity and route payload dispatch).
- **Status:** **FIXED** (via PR #38 commit 5cfe158; verified live Nov 1, 2026; merge into develop pending owner's word).

---

### [P1-4] Client Model Default is Swift-1.5 Instead of Flash-Next Profile
- **Feature:** Client-Side Model Default Selection & Settings Persistence
- **Affected Components:**
  - `web-ui/config/models.ts` (`AGENT_MODES`, `DEFAULT_PRIMARY_MODEL`, `DEFAULT_SUBAGENT_MODEL`)
  - `web-ui/app/page.tsx` (`selectedModel` initial state & persistence)
  - `web-ui/components/ChatStream.tsx` (`activeModel`, served model indicator)
  - `web-ui/app/api/chat/route.ts` (routing fallback mapping)
- **Steps to Reproduce:**
  1. Open a clean browser session at `http://192.168.50.254/` without prior localStorage.
  2. Inspect the model selection: Client defaulted to Swift-1.5 (`Swift-1.5-Qwen3.8-27B-IQ3_XS`) across `auto`, `flash`, and `pro` modes rather than the Flash-Next / Gyro-S server model.
  3. Change model in settings sheet; upon reload, preference was lost.
- **Expected Behavior:**
  1. Default model across all agent modes (`auto`, `flash`, `pro`) is `qwen3.8-flash-next-gyro-gyro-s` (Flash-Next).
  2. Model pill in the chat header reflects the served model name from the server stream (`qwen3.8-flash-next-gyro-gyro-s`).
  3. User model selections persist across browser reload in `localStorage`.
  4. Swift-1.5 profile remains selectable as a manual option.
- **Actual Behavior:**
  - Client defaulted to Swift-1.5, overriding server identity and requiring manual user intervention.
- **Resolution:**
  - Updated `DEFAULT_PRIMARY_MODEL` and `AGENT_MODES` defaults in `web-ui/config/models.ts` to `"qwen3.8-flash-next-gyro-gyro-s"`.
  - Added localStorage persistence for `preferred_model` in `web-ui/app/page.tsx`.
  - Remapped `Swift-1.5-Qwen3.8-27B-IQ3_XS` in `web-ui/app/api/chat/route.ts` to `DEFAULT_MODEL` when in auto mode.
  - Added per-message served model indicator in `web-ui/components/ChatStream.tsx`.
- **Severity:** **P1** (Client model defaults contradicted runtime server engine).
- **Status:** **FIXED** (2026-11-01; commit 22b4ec3; verified live on LAN 192.168.50.254 and localhost:3001 Nov 1, 2026).

---

### [P1-5] Engine Controls Act on Legacy In-Cluster Lifecycle + Strata Default Off
- **Feature:** Host Engine Controls (Start / Stop) & Boot Startup State
- **Affected Components:**
  - Startup directory: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\strata-standalone.vbs`
  - `scripts/lan-bridge.js` (Host reverse proxy bridge)
  - `web-ui/app/api/engine/route.ts`
  - `web-ui/components/EngineStatusPill.tsx`
  - `web-ui/components/ModelBottomSheet.tsx`
- **Steps to Reproduce:**
  1. Check Windows Startup folder: `strata-standalone.vbs` was active, causing Strata to autostart at login.
  2. Tap Engine STOP in UI: Failed or targeted in-cluster supervisor endpoint (`/control/stop`), returning 404 because Strata on host (:8080) does not implement the legacy control API.
  3. Engine status pill displayed mock or stale status.
- **Expected Behavior:**
  1. Strata's default state at boot is OFF (manual/on-demand startup only).
  2. Engine controls in the UI act on the real Strata host service (:8080).
  3. Status pill reflects true status (running when port 8080 `/health` returns `loaded: true`, stopped when offline).
  4. Clicking STOP cleanly stops the Strata host process, freeing VRAM and port 8080.
  5. Chat queries while stopped return loud honest in-turn engine-down error.
  6. Clicking START starts Strata, loads weights, and restores chat inference.
- **Actual Behavior:**
  - Autostart was enabled at boot via VBS script; engine controls in UI could not manage host Strata process.
- **Resolution:**
  - Disabled boot autostart by renaming `strata-standalone.vbs` to `strata-standalone.vbs.disabled`.
  - Wired `scripts/lan-bridge.js` to handle `/api/engine` requests with direct host process management (`start-strata.ps1` and `stop-strata.ps1`) and live health polling against `127.0.0.1:8080/health`.
  - Updated `web-ui/app/api/engine/route.ts` to probe `/health` directly when supervisor control is unavailable.
  - Aligned status pill and settings card labels to accurately reflect Strata.
  - Verified live full stop/start cycle: Stop killed process -> status stopped -> chat honest error -> Start launched process -> weights loaded -> live weather chat query answered via search_web.
- **Severity:** **P1** (Engine controls inoperative on host Strata service; autostart violation).
- **Status:** **FIXED** (2026-11-01; commit 8bc4e58; verified live on LAN 192.168.50.254 and localhost:3001 Nov 1, 2026).

---

### [P2-2] Chat Streaming Auto-Scroll Cannot Be Escaped (Reader Dragged to Bottom)
- **Feature:** Chat Stream Viewport & Follow-the-Tail Autoscroll
- **Affected Components:**
  - `web-ui/components/ChatStream.tsx` (`handleContainerScroll`, `handleContainerWheel`, `handleContainerTouchMove`, `isFollowPinnedRef`, streaming scroll effect)
- **Steps to Reproduce:**
  1. Submit a prompt producing a long multi-paragraph response (e.g., 800-word explanation of orbital mechanics).
  2. While the assistant is actively streaming tokens, scroll up toward the top to read earlier content.
  3. Observe viewport behavior during subsequent token arrival.
- **Expected Behavior:**
  1. Viewport follows the tail only while pinned to the bottom.
  2. Upward scroll gesture immediately and synchronously unpins follow mode (`isFollowPinnedRef.current = false`).
  3. Viewport remains firmly parked at the top or reader position without being dragged back to the bottom by streaming renders.
  4. Floating "Jump to bottom" affordance appears while unpinned with incoming content; clicking it cleanly re-pins and returns to bottom.
  5. User's own send action re-pins follow mode to the bottom.
- **Actual Behavior:**
  - Follow-state was tracked via asynchronous React state (`isUserScrolledUp`). Incoming streaming tokens arrived faster than state transitions, causing the effect's unguarded direct `el.scrollTop = el.scrollHeight` assignment to repeatedly yank the reader to the bottom.
- **Resolution:**
  - Introduced synchronous ref `isFollowPinnedRef` updated immediately within container scroll, wheel, and touchmove handlers.
  - Guarded programmatic scroll assignments with `isProgrammaticScrollRef` to prevent synthetic feedback loops into scroll handlers.
  - Consulted `isFollowPinnedRef.current` synchronously before executing programmatic autoscroll in streaming effects.
  - Wired floating Jump to Bottom button and user send actions to explicitly re-pin follow mode.
- **Severity:** **P2** (Viewport reading ergonomics degraded during long responses).
- **Status:** **FIXED** (2026-11-01; commit a7cf59a; verified via Playwright unit and live browser acceptance tests).

---

## Part 4 - Chat Runtime Fix-Phase Register (Nov 5, 2026)

**Round:** Fix phase on branch `feature/chat-runtime-fixes` (Part 1-3 defects below moved to punch-list `argon-cto/punchlist/punch-list.md`, IDs CHAT-1..CHAT-6). This section carries the defects registered here: CHAT-7 (new, Nov 5) and CHAT-8 (new, Nov 5), plus the CHAT-6 truth-up written under the punch-list entry. **CHAT-5 disposition (Nov 6, 2026):** closed via branch `feature/chat5-thread-identity` commit `18ddd43` (deployed `v-18ddd43-mw4arfie`) — behavior (a) SUPERSEDED-with-evidence (already present in HEAD), behavior (b) FIXED (`mergeStreamedTokens` merge instead of done-event replacement); full evidence in punch-list `CHAT-5` and its PR.

### [CHAT-7] Tool Loop Governed by a Fixed 8-Round Ceiling
- **Feature:** Chat Tool-Loop Continuation (`/api/chat`)
- **Affected Components:**
  - `web-ui/app/api/chat/route.ts` (`MAX_TOOL_ROUNDS` loop)
  - `web-ui/lib/contextBudget.ts` (`canContinueToolLoop`, `runChatToolLoop`)
- **Discovery:** Owner + sandbox chat driver, Nov 5, 2026. A multi-step inventory turn (git status + log + progress file + uncommitted inventory) needed ~9-12 tool rounds and hit the ceiling mid-task, ending with a `⚠️ [Tool execution limit reached (8 rounds).]` marker while work remained.
- **Steps to Reproduce:**
  1. Ask the chat agent for a multi-step inventory that needs more than 8 tool calls (host git status + git log + read a progress file + inventory uncommitted work).
  2. Observe the turn end at exactly 8 rounds with the limit marker and an unfinished summary.
- **Expected Behavior:** Tool rounds continue while context headroom remains; a turn ends when it has no more tool calls to make, when the context budget is exhausted, or only at a runaway backstop - never at an ordinary 8-round wall.
- **Actual Behavior:** `MAX_TOOL_ROUNDS = 8` hard-capped every turn; `canContinueToolLoop` returned only a boolean and did not consult token headroom.
- **Resolution:**
  - Continuation governed by context headroom (`estimateTokens(conversationMessages) <= budgetTokens`); the 8-round wall removed from the route entirely.
  - `TOOL_ROUND_BACKSTOP = 1000` as a runaway guard only; at the last permitted round `forceSynthesis` is set so tools are omitted and the model synthesizes.
  - `canContinueToolLoop` returns `ToolLoopDecision { canContinue, stopReason?, forceSynthesis? }` with stop reasons `completed` / `budget` / `backstop` / `web-research-cap`.
  - Round-0 guard: `lastRoundTools = []` must NOT stop round 0 (route initializes it before any round runs). Regression test added.
  - Grounding enforcement passes `awaitingToolRound: true` so an injected directive is not swallowed by the `completed` stop.
  - Web-research extension preserved: a round whose tools are exclusively research tools continues while `webResearchCalls < MAX_WEB_RESEARCH_CALLS` (100).
  - Honest pause markers keyed on stop reason for `budget`, `web-research-cap`, `backstop`.
- **Severity:** **P1** (turns truncated mid-task with a misleading limit marker; driver hit its limit literally).
- **Status:** **FIXED / VERIFIED LIVE** (Nov 5, 2026 — commit e0c4caf, deployed as image `local-agentic-sandbox-web-ui:v-e0c4caf-905758`. Fresh-thread acceptance on `thread-1793911038074-jjan`: Step 0 inventory turn completed in ONE turn (~1150s wall, 10 tool traces, single `done` event, status `completed`, no ⚠️ marker). Gate 314/314 at commit; full gate 326/326 after CHAT-8).

---

### [CHAT-8] Turns Invisible Live on Other Devices Until Completion
- **Feature:** Chat Live Visibility / Cross-Device Mid-Turn Rendering
- **Affected Components:**
  - `web-ui/app/api/chat/route.ts` (assistant message persisted only at turn end: done / error / abort)
  - `web-ui/lib/threads/threadStore.ts` (`ThreadMessage.status` union)
  - `web-ui/app/page.tsx` (thread load + polling loop)
  - `web-ui/components/ChatStream.tsx` (`ChatMessage.status` union, turn-status badge rendering)
- **Discovery:** Owner report + fix-phase audit, Nov 5, 2026. A turn running on one device shows nothing on any other device viewing the same thread: the server writes no assistant message to the ThreadStore until the turn ends (`done`/`error`/`abort` persistence), and clients only load thread messages once on thread switch (plus task-status polling for Build-mode runs, not chat turns).
- **Steps to Reproduce:**
  1. Start a long chat turn on device A.
  2. On device B (or a second browser/profile), open the same thread.
  3. Observe device B during the turn.
- **Expected Behavior:**
  1. The server writes throttled (~1/sec) ThreadStore snapshots of the streaming assistant content with message status `streaming` while the turn runs.
  2. A client viewing a thread whose latest assistant message is `streaming` polls `GET /api/threads/[id]` every ~1.5s and re-renders partial content until the status flips to a terminal state.
  3. The turn stays honestly "live" server-side while running (not reconciled to stopped by a mid-turn GET).
- **Actual Behavior:**
  1. Mid-turn `GET /api/threads/[id]` returns no assistant message (or the stale previous one) until the turn completes.
  2. No chat-turn polling existed on the client; only task (Build-mode) polling.
  3. Plain chat turns never registered the thread id in `activeExecutionSet`, so a mid-turn GET could reconcile an active thread to `stopped` and flag the last assistant message `isStopped`.
- **Resolution:**
  - `web-ui/lib/streamSnapshot.ts`: `ThrottledStreamSnapshot.maybeWrite()` writes `{ id: assistantMessageId, role: "assistant", content: accumulatedStreamedTokens, status: "streaming" }` into the ThreadStore at most once per `STREAM_SNAPSHOT_INTERVAL_MS` (1000 ms), keyed by the same message id so terminal persistence overwrites it (upsert).
  - `web-ui/app/api/chat/route.ts`: registers `activeThreadId` in `activeExecutionSet` for the duration of the turn (delete in `finally`), and calls `maybeWrite(accumulatedStreamedTokens)` in both the tool-round loop and the synthesis loop.
  - `web-ui/lib/threads/threadStore.ts` + `web-ui/components/ChatStream.tsx`: `status` unions extended with `"streaming"`; honest cyan "Streaming" badge rendered.
  - `web-ui/app/page.tsx`: while the latest assistant message of the selected thread is `streaming`, recursive `setTimeout` poll of `GET /api/threads/[id]` every `STREAM_POLL_INTERVAL_MS` (1500 ms), re-rendering messages until the status flips.
  - Two-client API test proves partial content visible mid-turn and convergence on terminal status.
- **Severity:** **P1** (core cross-device visibility degraded; a live turn appears frozen/hung on second client).
- **Status:** **FIXED / VERIFIED LIVE** (Nov 5, 2026 — commit 4bc71fc, deployed as image `local-agentic-sandbox-web-ui:v-4bc71fc-mw436dvd`. Dedicated suite `tests/chatLiveVisibility.test.ts` 8/8; gate 326/326. Two-client live acceptance on `thread-1793917113300-ip48`: persistent client streamed 143,982 SSE bytes to `done`; second client saw 73 `streaming` snapshots growing 1 → 11,162 chars via 1.5s polls, single transition streaming→completed, final 11,329 chars, exactly one upserted assistant message, no ⚠️ marker).

---

### [FEATURE-1] Chat Message Queue During Active Turns
- **Feature:** Client-Side Message Queue (Composer Non-Blocking Follow-ups)
- **Affected Components:**
  - `web-ui/lib/chatQueue.ts` (pure module with `StorageLike`, FIFO operations, `decideSendAction`, `drainNextForTurnEnd`)
  - `web-ui/components/ChatStream.tsx` (send-while-running enqueues text; queue chips rendered above composer with per-item `×` and `Clear all`; drains exactly one item on normal `DONE` via `turnActiveRef`)
  - `web-ui/tests/chatQueue.test.ts` (17 behavioral tests)
- **Status:** **IMPLEMENTED / VERIFIED LIVE** (Nov 6, 2026 — commit 0520a2a, deployed image `local-agentic-sandbox-web-ui:v-4ca0c42-mw5my380`).

---

### [FEATURE-2] Mid-Turn Steering Mailbox & Stream Events
- **Feature:** Mid-Turn Steering Mailbox & Transcript Injection
- **Affected Components:**
  - `web-ui/lib/threads/threadStore.ts` (`appendSteer`, `consumeSteers`, `getPendingSteers`, `clearSteers` sidecar mailbox)
  - `web-ui/app/api/threads/[id]/steer/route.ts` (`POST /api/threads/[id]/steer`)
  - `web-ui/app/api/chat/route.ts` (consumes steer mailbox at every round boundary & pre-synthesis; persists as `[Steer from user, mid-turn]`; emits `{ type: "steer", texts }`; returns unconsumed in `done` as `pendingSteers`)
  - `web-ui/components/ChatStream.tsx` (Queue vs Steer toggle during active turns; transcript renders `steer` events; auto-queues unconsumed `pendingSteers`)
  - `web-ui/tests/chatSteer.test.ts` (8 behavioral tests)
- **Status:** **IMPLEMENTED / VERIFIED LIVE** (Nov 6, 2026 — commit f1fab48, deployed image `local-agentic-sandbox-web-ui:v-4ca0c42-mw5my380`).

---

### [CHAT-9 / INV-B] Turn Presence for Instant Cross-Device Visibility
- **Feature:** Active-Turn Presence Registry (Pre-Token Blind Window Elimination)
- **Affected Components:**
  - `web-ui/lib/threads/threadStore.ts` (`markTurnActive`, `getActiveTurn`, `clearTurnActive`)
  - `web-ui/app/api/threads/[id]/route.ts` (`GET` returns `activeTurn` presence info even before thread file exists)
  - `web-ui/app/api/chat/route.ts` (sets presence immediately on turn start; clears on done/abort/error)
  - `web-ui/tests/chatTurnPresence.test.ts` (7 behavioral tests)
- **Status:** **FIXED / VERIFIED LIVE** (Nov 6, 2026 — commit 9f9b61e, deployed image `local-agentic-sandbox-web-ui:v-4ca0c42-mw5my380`. Live probe verified watcher presence within 114ms of turn start, reducing pre-token blind window from ~18s to <0.2s).

---

## Part 5 - Overnight Shakeout Battery Register (Nov 7, 2026)

### [CHAT-10] Server Restart Mid-Turn Leaves Orphaned Streaming Assistant Message and Flips Thread Status to Completed
- **Feature:** Chat Turn Persistence & Server Restart Reconciliation
- **Affected Components:**
  - `web-ui/lib/threads/threadStore.ts` (`addMessage`, `reconcileThread`)
  - `web-ui/app/api/chat/route.ts` (turn-start thread status activation)
- **Discovery:** Overnight Shakeout Battery Probe D4 (`shakeout-batch2.log`, Nov 7, 2026). Restarting `deployment/web-ui` while a chat turn was streaming on `thread-d4-1794048774348` left the thread's assistant message stuck in `status: "streaming"` permanently while `thread.status` flipped to `"completed"`.
- **Steps to Reproduce:**
  1. Start a chat turn on an existing thread or let `ThrottledStreamSnapshot` write a `status: "streaming"` assistant snapshot.
  2. Restart the `web-ui` server process (clearing in-memory `activeExecutionSet` and `activeTurnRegistry`) before the turn reaches a terminal state.
  3. Query `GET /api/threads/<id>`.
- **Expected Behavior:**
  1. While a message with `status: "streaming"` is written via `addMessage`, `thread.status` remains `"active"` (never flipped to `"completed"` mid-stream).
  2. When `reconcileThread` runs on a thread that is no longer live in `activeExecutionSet` or `getActiveTurn(thread.id)`, any trailing assistant message still marked `status: "streaming"` is reconciled to `status: "incomplete"`, `isStopped: true`, with `"⚠️ [Turn incomplete: Server restarted or turn interrupted.]"` appended, and `thread.status` is set to `"stopped"`.
- **Actual Behavior:**
  1. `ThreadStore.addMessage` unconditionally executed `if (thread.status !== "active") { thread.status = "completed"; }` for any assistant message, including `status: "streaming"` snapshots on threads whose previous turn had finished (`status: "completed"` or `"stopped"`).
  2. Because `thread.status` became `"completed"` during streaming, `reconcileThread` (which only checked `if (thread.status === "active")`) skipped the thread after pod restart, and even for `"active"` threads never transitioned `lastMsg.status === "streaming"` out of `"streaming"`. Clients polling `GET /api/threads/[id]` saw `status: "streaming"` forever.
- **Severity:** **P1** (causes infinite 1.5s client polling and permanently stuck "Streaming" badge after pod rollout/restart).
- **Status:** **OPEN** (registered prior to fix).

---

### [CHAT-11] Mid-Turn Steer Endpoint Accepts Nonexistent Thread IDs with 200 OK and Writes Orphan Sidecars
- **Feature:** Mid-Turn Steering API (`POST /api/threads/[id]/steer`)
- **Affected Components:**
  - `web-ui/app/api/threads/[id]/steer/route.ts`
- **Discovery:** Overnight Shakeout Battery Probe C3 (`shakeout-batch1.log`, Nov 7, 2026). Sending `POST /api/threads/nonexistent-thread-999999/steer` returned HTTP `200` (`{"success":true,"pendingCount":1}`) and created an orphan `.steer.json` file on disk.
- **Steps to Reproduce:**
  1. Send `POST /api/threads/nonexistent-thread-999999/steer` with `{"text": "orphan steer"}`.
  2. Observe HTTP status code and `THREADS_DIR` contents.
- **Expected Behavior:**
  If the target thread ID neither exists in `ThreadStore` nor has a live turn in `getActiveTurn(id)` / `activeExecutionSet`, `POST /api/threads/[id]/steer` rejects with HTTP `404 Not Found` and writes no `.steer.json` file.
- **Actual Behavior:**
  `POST /api/threads/[id]/steer` called `store.appendSteer(id, text)` unconditionally without verifying thread existence or active turn state.
- **Severity:** **P2** (dishonest 200 response for nonexistent thread and orphan sidecar file creation).
- **Status:** **OPEN** (registered prior to fix).

---

### [CHAT-12] Requesting an Unavailable Model Name on `/api/chat` Silently Runs Resident Model and Spoofs `modelUsed`
- **Feature:** Chat Model Dispatch & Turn Honesty (`POST /api/chat`)
- **Affected Components:**
  - `web-ui/app/api/chat/route.ts`
- **Discovery:** Overnight Shakeout Battery Probe E1 (`shakeout-batch1.log`, Nov 7, 2026). Sending `POST /api/chat` with `model: "totally-nonexistent-model-xyz-999"` succeeded with HTTP 200, streamed a normal completion from the resident Strata GGUF model, and persisted `modelUsed: "totally-nonexistent-model-xyz-999"` on the assistant message.
- **Steps to Reproduce:**
  1. Send `POST /api/chat` with `{"model": "totally-nonexistent-model-xyz-999", "messages": [{"role": "user", "content": "Say hi"}]}`.
  2. Inspect the SSE stream events and persisted assistant message in `GET /api/threads/<id>`.
- **Expected Behavior:**
  When the caller explicitly requests a model ID that is not `"auto"`, not the configured `DEFAULT_MODEL` / legacy default alias, and not a known profile in `PRESET_MODEL_PROFILES`, the route fails honestly by throwing an explicit model-unavailable error (`Model "<id>" is not available on the active inference engine.`), emitting an SSE `error` event and persisting the assistant message with `status: "error"` and `"⚠️ [Turn error: ...]"`.
- **Actual Behavior:**
  Because single-slot `llama-server` / Strata ignores the `model` field in `/v1/chat/completions`, `route.ts` passed the bogus model ID straight through and recorded the bogus string as `modelUsed`.
- **Severity:** **P1** (violates turn honesty and model attribution; spoofs `modelUsed` with an arbitrary nonexistent model name).
- **Status:** **OPEN** (registered prior to fix).

