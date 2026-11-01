# End-to-End Shakeout Bug Register

**Date:** 2026-10-24  
**Amended:** 2026-10-28 — retro-registered omissions: P0-A and P0-B were in the Oct 24 shakeout scope but were never entered below. Documentation-only amendment; no fixes included.  
**Amended:** 2026-11-01 — status truth-up & closure (Part B register sweep: P0-1, P0-2, P0-3, P1-1, P1-2, P2-1 verified fixed in commit bfb8e2c; P0-A, P0-B design blocked; P0-6, P1-3 fixed via PR #38 commit 5cfe158).  
**Scope:** Deployed cluster (`http://127.0.0.1:3001` and `http://192.168.50.254:80`), real LLM engine (`Swift-1.5-Qwen3.8-27B-IQ3_XS`), real git repository, real workspace persistent volume.  
**Branch:** `feature/projects-and-folders` (PR #35).

---

## Register Metric
- **Total Defects Identified:** 8
- **P0 Defects (Blocks Core Use):** 5
- **P1 Defects (Degraded Functionality):** 2
- **P2 Defects (Minor / Polish):** 1

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
- **Status:** **OPEN (unfixed)** — no commit fixes this defect.

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
- **Status:** **OPEN (unfixed)** — no commit fixes this defect.

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
