# End-to-End Shakeout Bug Register

**Date:** 2026-10-24  
**Scope:** Deployed cluster (`http://127.0.0.1:3001` and `http://192.168.50.254:80`), real LLM engine (`Swift-1.5-Qwen3.8-27B-IQ3_XS`), real git repository, real workspace persistent volume.  
**Branch:** `feature/projects-and-folders` (PR #35).

---

## Register Metric
- **Total Defects Identified:** 6
- **P0 Defects (Blocks Core Use):** 3
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
