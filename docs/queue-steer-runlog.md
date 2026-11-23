# Queue Steer Runlog

## job-auto-1 (auto-resume attempt 1/2) — retryAfter parser

- Banked state found on resume: sandbox branch `feat/task-179482628980` held an
  uncommitted `retryAfter.mjs` rewrite plus untracked `tests/retryAfter.test.mjs`.
  Prior commits on that branch were unrelated scratch milestones (M1/M2 stubs).
- Verified scope: `parseRetryAfter(headerValue, nowMs = 0)` per AC-2-1/AC-2-2/AC-2-3.
- Tests run (host checkout, branch `feature/retry-after-parser`):
  - `node --test tests/retryAfter.test.mjs` -> 9 pass / 0 fail.
  - Grader suite `D:\AI\orchestrator-scratch\retryafter-grader\retryAfter.test.mjs`
    run against the workspace implementation -> 4 pass / 0 fail.
- Contract notes:
  - null/undefined/empty/whitespace-only -> null
  - non-negative integer seconds -> nowMs + seconds*1000; "0" -> 0 always
  - HTTP-date -> max(0, Date.parse(value) - nowMs)
  - negative / non-integer / unparseable -> null
- Status: COMPLETE. Files committed on `feature/retry-after-parser` (PR into develop).
- Auto-resume attempt 1/2: found an in-progress merge of origin/develop into
  `feature/retry-after-parser` with two conflicts (`docs/queue-steer-runlog.md`,
  `web-ui/tests/retryAfter.test.ts`). Resolved both to a union (keep both runlog
  sections; keep our `../lib/retryAfter.mjs` import under develop's prettier
  formatting). Merge committed as `71ad704`. Targeted gate
  `npx tsx scripts/test-gate.ts --files=web-ui/tests/retryAfter.test.ts` -> 14 pass / 0 fail.
  Note: the gate initially failed on a missing `typescript` devDependency (not hoisted
  to the workspace root); installed `typescript@5.7.3 --no-save` at root to fix the
  eval-pack grader's `tsc` spawn and the mcp-server typecheck. Environment gap, not a
  regression from this job.
- Auto-resume attempt 1/2 (continuation): re-ran grader against repo
  `web-ui/lib/retryAfter.mjs` -> 4 pass / 0 fail; `npx tsx --test
web-ui/tests/retryAfter.test.ts` -> 14 pass / 0 fail. Full change-aware gate via
  bridge: `npx tsx scripts/test-gate.ts --since=origin/develop` -> PASSED, 409 pass /
  0 fail / 2 skip in 59.4s (<90s budget). Pitfall logged: `npm run test:gate
-- --since=...` swallows `--since` as npm's own config flag and silently drops the
  changed-file scope (selected only 2 suites); invoke `npx tsx scripts/test-gate.ts
--since=...` directly instead.
- Status: COMPLETE. PR opened into develop.
- Auto-resume attempt 1/2 (re-verification): branch `feature/retry-after-parser` clean,
  PR #217 OPEN + MERGEABLE. Targeted gate
  `node scripts/test-gate.js --files=web-ui/tests/retryAfter.test.ts` -> 14 pass / 0 fail.
  Full change-aware gate scoped to committed diff
  `node scripts/test-gate.js --since=origin/develop` -> PASSED, 409 pass / 0 fail in 61s
  (<90s budget), with `tests/retryAfter.test.ts` in the selected suite list.
  Pitfall reconfirmed: bare `node scripts/test-gate.js` (no `--since`) picks up the 8
  untracked `eval/results/*` scratch dirs as "changed files", so change detection selects
  only the eval-pack + skillGate suites (2 suites) and silently drops the retryAfter slice.
  Scope the gate with `--since=origin/develop` to exclude untracked scratch. No code change
  needed; job remains COMPLETE.
- Auto-resume attempt 1/2 (final re-verification, 2026-11-20): branch clean, PR #217
  OPEN + MERGEABLE into develop. Targeted gate
  `node scripts/test-gate.js --files=web-ui/tests/retryAfter.test.ts` -> 14 pass / 0 fail
  (4.5s). Scoped full gate `node scripts/test-gate.js --since=origin/develop` -> PASSED,
  636 pass / 0 fail / 2 skip in 67.2s (<90s budget); suite count grew from 409 to 638 as
  develop advanced (Board #54/#56/#59 slices merged in), `tests/retryAfter.test.ts` still
  selected. No code change required; job remains COMPLETE.
- Auto-resume attempt 1/2 (2026-11-23 re-verification): deliverable is MERGED, not open.
  PR #217 state = MERGED (`gh pr list --state all`), merge commit `5130bb3` on develop;
  `web-ui/lib/retryAfter.mjs` and `web-ui/tests/retryAfter.test.ts` present on
  `origin/develop` (14-test suite incl. HTTP-date cases). Targeted gate in the host
  checkout `node scripts/test-gate.js --files=web-ui/tests/retryAfter.test.ts` ->
  14 pass / 0 fail in 9.8s (<90s budget). Environment gap logged: a fresh worktree off
  `origin/develop` has no `node_modules`, so `scripts/test-gate.js` fails with
  `Cannot find module .../node_modules/tsx/dist/cli.mjs` until deps are installed there;
  verification was run in the host checkout instead. No code change required; job
  remains COMPLETE and nothing further to bank for this job.

## Board #54 — eval/run.mjs tool-discipline misgrading, timeout/fault isolation, --out, fabricated slotMetrics

- Worktree: `C:\Users\zackm\Desktop\repos\ls-worktree-54`, branch `feature/eval-run-tool-discipline-and-fault-isolation` (off origin/develop @ 8579193).
- Test-first: added `web-ui/tests/evalRunnerEndpointDiscipline.test.ts` (6 tests) covering all three ACs before implementation.
- Fixes in `eval/run.mjs`:
  - `callEndpoint` now records `toolCallsExecuted` from `finish_reason: 'tool_calls'` (was hardcoded 0, which failed compliant models — run 2026-11-20T17-10-01-179Z) and simulates the injected stall round: injects a `role: "tool"` stall message and asks for a follow-up, so tool-discipline grades stall honesty instead of penalizing valid tool_calls.
  - Every endpoint request carries `AbortSignal.timeout(DEFAULT_TASK_TIMEOUT_MS)` (600s > Node's 300s headers default); `--timeout=` overrides per-task budget.
  - `runEvalTasks` wraps each task in try/catch: a failing task is recorded as `passed: false` with `evidence.error` + `<task>.error.json`, remaining tasks still run, scorecard.json/md always written. Reproduces the UND_ERR_HEADERS_TIMEOUT kill (run 2026-11-20T17-04-44-625Z).
  - `--out` honored: outputs go to `path.resolve(args.out)` instead of hardcoded `eval/results`.
  - slotMetrics no longer fabricated (100% util / 0ms owner wait). Endpoint mode omits it; scorecard.md renders "Slot Utilization: N/A". Job mode fetches real scheduler stats from `/api/scheduler/stats` (undefined on failure, never fabricated).
- Tests: `npx tsx --test tests/evalRunnerEndpointDiscipline.test.ts` -> 6 pass / 0 fail; `tests/evalRunnerJobMode.test.ts` -> 2 pass / 0 fail (no regression).
- Status: COMPLETE pending `npm run test:gate` via bridge + PR into develop.

## Board #56 - Reconcile README, ARCHITECTURE, docs, and UI copy with live product behavior and test counts

- Worktree: `D:\AI\orchestrator-scratch\wt-56-docs-reconcile`, branch `feature/docs-ui-reconcile` (off origin/develop @ a50b47b).
- Live census verified: `playwright test --list` = 284 tests / 13 spec files / 4 projects; `tsx --test tests/*.test.ts` = 1,930 tests / 283 files (1,928 pass, 2 skip); Strata `/health` = service `strata`, model `qwen3.8-flash-next-gyro-gyro-s`, `max_context` 131072, single model served; `llm-rocm-gpu` (Ollama harness) scaled to 0; live kubectl posture probe = uid 10001, `/proc/mounts` root `overlay ro`, `CapEff 0`.
- Test-first: 6 new assertions in `web-ui/tests/docsIntegrity.test.ts` (Playwright census, unit census, egress wording, agentEngine.ts absence, ESM attestation snippet, lan-bridge README section citation) - red (6 fail), then green after doc patches.
- Patches (one file per commit):
  - README.md: egress claim replaced with accurate host-port boundary (:8080/:11434/:11435/:8765 + internal services); board copy states PATCH /api/board edit + drain-gated auto-start; model line: swift fallback on optional Ollama harness; test counts 1,930/283 and 284/13/4; added `### LAN bridge security` section cited by scripts/lan-bridge.js:124.
  - ARCHITECTURE.md: nonexistent `lib/agentEngine.ts` replaced with `lib/board/dispatcher.ts`; test census updated; fallback model moved to optional Ollama harness (diagram + matrix + repo map + quickstart).
  - docs/AI_GOVERNANCE.md: broken `require('./dist/tools/attestation.js')` snippet replaced with live-verified kubectl posture probe mirroring `verify_container_provenance`.
  - docs/MODEL_RESIDENCY.md: single resident model, `--max-context 131072`, swift fallback residency corrected.
  - web-ui/components/ModelBottomSheet.tsx: engine label `Strata Engine (host GPU)` (was "Standalone llama.cpp Engine"); engineToggle.test.ts assertion updated to match.
  - web-ui/components/BoardView.tsx: working-column copy now honest: auto-start only when board control is `running` (schedulerDaemon.ts:249-256, boardControl.ts).
  - deploy/k8s/network-policies.yaml: comments state port-only host egress semantics; README documents the boundary (AC route: accurate documentation; ipBlock tightening left off to avoid risking prod web-ui under docker-desktop CNI).
- Verification: docsIntegrity 11/11 green; engineToggle + settingsView green; `npm run test:gate` via bridge.

## Board Item #59 — Single-emerald accent + dark-mode contrast floor (BoardView, ChatStream, SettingsView)

- Worktree: `C:\Users\zackm\Desktop\repos\board59-wt`, branch `feature/emerald-accent-contrast-floor` (off develop).
- Test-first: `web-ui/tests/accentContrastAudit.test.ts` (banned cyan/sky scan on BoardView + ChatStream; rose-400 heading floor check; disabled-control floor check) and `web-ui/tests/e2e/settingsMobile.spec.ts` (412px dark Playwright render audit: zero banned accent classes across Settings/Board/Chat, Danger Zone heading and disabled Start button clear the zinc-400-on-#000 floor of 8.2). Both red before the fix.
- Patches (one file per commit):
  - web-ui/components/BoardView.tsx: banned cyan accents on active/working states replaced with single-emerald tokens (`border-emerald-500/40`, `text-emerald-300/400`, `bg-emerald-*`).
  - web-ui/components/ChatStream.tsx: steer pending-deck border/chip/italic sky accents -> emerald; steer-queue expand chevron sky -> emerald; active queue chip cyan -> emerald; mid-turn Steer button `bg-cyan-600` -> `bg-emerald-600` with dark-mode `bg-emerald-400 text-black` variant.
  - web-ui/components/settings/DangerZone.tsx: heading `dark:text-rose-400` (7.80 on #000, below floor) -> `dark:text-rose-300` (11.05); ShieldAlert icon lifted to match.
  - web-ui/components/settings/EngineZone.tsx + NotificationsZone.tsx: disabled controls `opacity-50 ... dark:text-zinc-400` (5.81 on zinc-800) -> full-opacity `dark:bg-zinc-800 dark:text-zinc-300` (10.08); light-mode disabled text lifted zinc-400 -> zinc-500 (4.4 on zinc-100).
  - web-ui/components/settings/MemoryZone.tsx: `disabled:opacity-50` -> `disabled:bg-zinc-800 disabled:text-zinc-300 disabled:cursor-not-allowed`.
  - web-ui/lib/testGate.ts: new MAPPING_RULES entry wiring accentContrastAudit.test.ts to BoardView/ChatStream/SettingsView/settings zones (gateManifestCompleteness green).
- Verification: accentContrastAudit 4/4, darkTextFloor 2/2, settingsView 8/8, parityChatSurfaces 11/11, paritySidebarDrawer 11/11, uirHeaderActivity 20/20, gateManifestCompleteness 1/1 green; `npm run test:gate` PASSED: 687 unit tests + 128 Playwright specs (incl. settingsMobile 5/5 across all 4 projects), 0 failed.
- Note: `transition-all` on engine buttons animates the disabled-state background; the e2e floor check waits 400ms for the transition to settle before measuring computed contrast.

## Board item #63 � skip unused per-chat worktree creation

- Worktree: C:\Users\zackm\Desktop\repos\lsb-job63, branch feature/chat-turn-worktree-skip (off develop).
- Evidence: web-ui/app/api/chat/route.ts passed repoRoot: resolveJobRepoRoot() to serializeTurn, which created+deleted a git worktree per chat turn; the handle was only consumed by chunkWorkspaceRoot (web-ui/lib/chat/roundLoop.ts:663) for the runlog path. MCP workspace tools execute via target.client.callTool against the container shared /workspace (roundLoop.ts:1613) - never _worktree.path. So the worktree was pure git churn, no isolation.
- Decision (assumption logged): REMOVE the unused per-turn worktree rather than thread a workspace root through MCP tools; mcp-server/src/tools/workspaceTools.ts has no workspace-root parameter today, so real isolation is a separate mcp-server change. serializeTurn keeps repoRoot support for job-queue callers (jobQueueIsolation.test.ts untouched).
- Test-first: web-ui/tests/jobQueueRoute.test.ts - new test asserts chat route source has no repoRoot: resolveJobRepoRoot()/createJobWorktree, and serializeTurn without repoRoot runs runTurn with null worktree and creates no .git/worktrees dir. Red before fix.
- Patch: web-ui/app/api/chat/route.ts - dropped repoRoot from serializeTurn options, renamed chatTurnWorktreeSeq -> chatTurnSeq, updated comment to record the #63 rationale.
- Verification: jobQueueRoute.test.ts 11 pass / 0 fail; npm run test:gate PASSED: 370 tests, 0 failed (budget 240s, took ~48s).

## Board #125 (Perf P2) - enable parallel tool calls for read-only fanout

- Worktree: C:\Users\zackm\Desktop\repos\perf-p2-wt, branch feature/perf-p2-parallel-tools (off develop).
- Test-first (commit 8f7b6fd, banked by prior attempt): web-ui/tests/parallelReadOnlyFanout.test.ts pins partitionToolCallBatches (read-only batch + write barrier + cap 8) and a roundLoop contract proving 3 read-only calls produce 3 traces in ONE round; wired into web-ui/lib/testGate.ts manifest.
- Contract test flipped in web-ui/tests/llmProvider.test.ts: streamChat must send parallel_tool_calls: true when tools are present (runaway protection lives in the fanout partition, not the request flag).
- New test added: multi-index delta tool_calls must survive accumulation (index 1 deltas no longer dropped) so parallel batches reach partitionToolCallBatches in emission order.
- Patch web-ui/lib/llm/provider.ts: (1) requestBody.parallel_tool_calls = true when tools present (was hardcoded false); (2) removed the "if (idx > 0) continue" runaway guard in the delta tool-call accumulator - it silently discarded every parallel call, so enabling the flag alone would have changed nothing.
- Verification: llmProvider.test.ts + parallelReadOnlyFanout.test.ts 46 pass / 0 fail; npm run test:gate PASSED: 140 tests, 0 failed, 20.63s (<90s budget).
- Note: .gitignore and web-ui/Dockerfile show CR-only diffs in this worktree (line-ending churn from a prior attempt); excluded from commits.
