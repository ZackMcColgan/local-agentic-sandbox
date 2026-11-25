# Queue Steer Runlog

## job-auto-1 (auto-resume attempt 1/2) â€” retryAfter parser

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

## Board #54 â€” eval/run.mjs tool-discipline misgrading, timeout/fault isolation, --out, fabricated slotMetrics

- Worktree: `C:\repos\ls-worktree-54`, branch `feature/eval-run-tool-discipline-and-fault-isolation` (off origin/develop @ 8579193).
- Test-first: added `web-ui/tests/evalRunnerEndpointDiscipline.test.ts` (6 tests) covering all three ACs before implementation.
- Fixes in `eval/run.mjs`:
  - `callEndpoint` now records `toolCallsExecuted` from `finish_reason: 'tool_calls'` (was hardcoded 0, which failed compliant models â€” run 2026-11-20T17-10-01-179Z) and simulates the injected stall round: injects a `role: "tool"` stall message and asks for a follow-up, so tool-discipline grades stall honesty instead of penalizing valid tool_calls.
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

## Board Item #59 â€” Single-emerald accent + dark-mode contrast floor (BoardView, ChatStream, SettingsView)

- Worktree: `C:\repos\board59-wt`, branch `feature/emerald-accent-contrast-floor` (off develop).
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

## Board item #63 ï¿½ skip unused per-chat worktree creation

- Worktree: C:\repos\lsb-job63, branch feature/chat-turn-worktree-skip (off develop).
- Evidence: web-ui/app/api/chat/route.ts passed repoRoot: resolveJobRepoRoot() to serializeTurn, which created+deleted a git worktree per chat turn; the handle was only consumed by chunkWorkspaceRoot (web-ui/lib/chat/roundLoop.ts:663) for the runlog path. MCP workspace tools execute via target.client.callTool against the container shared /workspace (roundLoop.ts:1613) - never _worktree.path. So the worktree was pure git churn, no isolation.
- Decision (assumption logged): REMOVE the unused per-turn worktree rather than thread a workspace root through MCP tools; mcp-server/src/tools/workspaceTools.ts has no workspace-root parameter today, so real isolation is a separate mcp-server change. serializeTurn keeps repoRoot support for job-queue callers (jobQueueIsolation.test.ts untouched).
- Test-first: web-ui/tests/jobQueueRoute.test.ts - new test asserts chat route source has no repoRoot: resolveJobRepoRoot()/createJobWorktree, and serializeTurn without repoRoot runs runTurn with null worktree and creates no .git/worktrees dir. Red before fix.
- Patch: web-ui/app/api/chat/route.ts - dropped repoRoot from serializeTurn options, renamed chatTurnWorktreeSeq -> chatTurnSeq, updated comment to record the #63 rationale.
- Verification: jobQueueRoute.test.ts 11 pass / 0 fail; npm run test:gate PASSED: 370 tests, 0 failed (budget 240s, took ~48s).

## job-auto-1 (auto-resume attempt 1/2, 2026-11-24) â€” retryAfter scope closed; EOL renormalize follow-up for PR #222

- Banked state on resume: job-auto-1 scope (`parseRetryAfter`, AC-2-1/2-2/2-3) is DONE and merged â€” PR #217 MERGED 2026-11-22T23:24:59Z; `web-ui/lib/retryAfter.mjs` and `web-ui/tests/retryAfter.test.ts` present on origin/develop (blobs 5c39409 / 104866c). No restart needed; scope verified by presence, not re-implementation.
- Repo-standards work (Board #120) also already banked: PR #222 MERGED 2026-11-23T01:23:19Z (`feature/repo-standards-sweep` @ b074983: community files, dependabot, `.nvmrc`, `.gitattributes`, `repoStandards.test.ts`, gate wiring).
- Real residual on resume: working tree showed a phantom 140-line diff on `web-ui/Dockerfile` + 2-line diff on `.gitignore`. Root cause: PR #222 added `.gitattributes` (`* text=auto eol=lf`, explicit `Dockerfile text eol=lf`, `.gitignore text eol=lf`), but blobs committed before that attribute carry CRLF, so git reports a content-identical line-ending change. Confirmed with `git diff --ignore-cr-at-eol --stat` -> empty (pure EOL change, zero content drift).
- Fix: `git add --renormalize .` sweep. On the develop tree the sweep lands exactly one file (`web-ui/Dockerfile`, 70/70 lines); `.gitignore` was already LF. Committed on `feature/eol-renormalize` (off origin/develop @ 4a96d6b) as `1271b44 chore(repo): renormalize CRLF blobs to LF per .gitattributes eol=lf`.
- Gate: `node scripts/test-gate.js --since=HEAD~1` -> PASSED, 7 pass / 0 fail in 11.9s (<90s budget). Targeted `repoStandards.test.ts` -> 9 pass / 0 fail (5.3s).
- Pitfall reconfirmed (blocking, not a regression): `node scripts/test-gate.js --since=origin/develop` from this checkout counts the 8 untracked `eval/results/*` scratch dirs as changed files (124 files inspected, 0 suites selected) and then rejects with ZERO TEST COVERAGE on unrelated develop-side modules (`web-ui/lib/hostPathRestriction.ts`, `web-ui/lib/streamPollGate.ts`). Scope the gate with `--since=HEAD~1` (committed diff only) or clean the scratch dirs first. Scratch dirs left untouched (eval artifacts, not this job's scope).
- Status: job-auto-1 scope COMPLETE (merged). EOL renormalize follow-up committed on `feature/eol-renormalize`, PR into develop.

## Board #125 (Perf P2) - enable parallel tool calls for read-only fanout

- Worktree: C:\repos\perf-p2-wt, branch feature/perf-p2-parallel-tools (off develop).
- Test-first (commit 8f7b6fd, banked by prior attempt): web-ui/tests/parallelReadOnlyFanout.test.ts pins partitionToolCallBatches (read-only batch + write barrier + cap 8) and a roundLoop contract proving 3 read-only calls produce 3 traces in ONE round; wired into web-ui/lib/testGate.ts manifest.
- Contract test flipped in web-ui/tests/llmProvider.test.ts: streamChat must send parallel_tool_calls: true when tools are present (runaway protection lives in the fanout partition, not the request flag).
- New test added: multi-index delta tool_calls must survive accumulation (index 1 deltas no longer dropped) so parallel batches reach partitionToolCallBatches in emission order.
- Patch web-ui/lib/llm/provider.ts: (1) requestBody.parallel_tool_calls = true when tools present (was hardcoded false); (2) removed the "if (idx > 0) continue" runaway guard in the delta tool-call accumulator - it silently discarded every parallel call, so enabling the flag alone would have changed nothing.
- Verification: llmProvider.test.ts + parallelReadOnlyFanout.test.ts 46 pass / 0 fail; npm run test:gate PASSED: 140 tests, 0 failed, 20.63s (<90s budget).
- Note: .gitignore and web-ui/Dockerfile show CR-only diffs in this worktree (line-ending churn from a prior attempt); excluded from commits.

## Board #127 (Perf P3) - thought stream delta-only

- Worktree: C:\repos\perf-wt, branch feature/perf-p3-thought-stream (off fresh origin/develop).
- Client claim verified: web-ui/components/ChatStream.tsx handles delta `thinking` events (line ~1177, appends event.content to msg.thought) and round-boundary `thought` events (line ~1167, replaces msg.thought + thinkingSegments); the terminal `done` event carries the final thought. So per-token cumulative `thought` events are NOT required by the client - item proceeds.
- Test-first: web-ui/tests/thoughtStreamDeltaOnly.test.ts (3 tests) - N thinking tokens produce N `thinking` deltas and at most one `thought` per round; synthesis pass emits deltas only, never a cumulative `thought`. Confirmed failing for the stated reason before the fix (roundLoop emitted 0 thinking deltas + per-token cumulative thought; synthesis emitted 3 cumulative thought events).
- Patch web-ui/lib/chat/roundLoop.ts: per thinking token now emits ONLY the `thinking` delta; cumulative `thought` fires at most once per round - either a throttled snapshot flush (streamSnapshot.maybeWrite returns true, <=1/sec) or the round boundary, deduped via thoughtEventThisRound. Removed the redundant post-round thought emit.
- Patch web-ui/lib/chat/turnEngine.ts (runSynthesisPass): removed the per-token cumulative `thought` sendEvent; thinking tokens emit only the `thinking` delta; cumulative thought reaches the client via the throttled snapshot and the terminal `done` event.
- Wired new test into web-ui/lib/testGate.ts MAPPING_RULES (additive rule matching lib/chat/roundLoop, lib/chat/turnEngine, thoughtStreamDeltaOnly.test.ts).
- Verification: thoughtStreamDeltaOnly 3/0; chatThinkingPreservation 4/0; chatTurnEngine 5/0; chatRoundLoop 3/0; chatStreaming 10/0; chatStreamTokenPreservation 11/0; activityTimeline 22/0; chatReasoningAndProgress 19/0; thinkingPanel 6/0; chatLiveVisibility 8/0; turnSurvival 12/0; npx tsc --noEmit clean; npm run test:gate PASSED 82/0 (<90s budget).
- Assumption: the brief permits cumulative `thought` at "round boundaries / snapshot flushes"; the flush-gated event carries the cumulative-so-far prefix (not the full round text), which ChatStream.tsx accepts since the round-boundary/done events supply the full thought.
- Note: .gitignore and web-ui/Dockerfile CR-only churn excluded from commits.

## Board #129 (Perf P5) - mid-turn compaction uses extraction digest + release engine slot during tool waits

- Worktree: C:\repos\local-agentic-sandbox\.worktrees\perf-p5, branch feature/perf-p5-compaction-slot (base f209f39, perf-p3 merged).
- Problem A: mid-turn hybrid compaction dispatched a secondary summarization LLM call on the SINGLE engine slot with a different system prompt, evicting the active turn's prefix state (next main round restarts at zero reuse; 1,158 evictions in the engine log).
- Problem B: the turn's slot lease was held through long tool waits (30-60s installs/tests) although lease.releaseForWait() existed in web-ui/lib/slotScheduler.ts and was never called.
- Test-first: web-ui/tests/engineSlotReleaseDuringToolWait.test.ts (3 tests) - P5-A pins resolveMidTurnHybridEnabled default OFF + roundLoop mid-turn branch gated on it; P5-B drives two turns through serializeTurn+JobQueue+shared scheduler with a mock engine and asserts queued turn B dispatches its LLM round DURING turn A's tool wait, and A re-acquires before its round 2. Red before fix (order was llm_A1, tool_start, tool_end, llm_A2, llm_B).
- Patch web-ui/lib/conversationCompaction.ts: resolveMidTurnHybridEnabled() - MID_TURN_HYBRID_COMPACTION opt-in flag, default OFF (single-slot engine).
- Patch web-ui/lib/chat/roundLoop.ts: mid-turn compaction branch now requires resolveCompactionStrategy()==="hybrid" AND resolveMidTurnHybridEnabled(); hybrid rung stays wired at turn boundary and manual /compact. runChatTurn takes the slot lease; the whole tool-batch execution (parallel fanout + sequential barrier batches) runs inside lease.releaseForWait() so the engine slot is free during host tool waits and re-acquired before the next LLM round.
- Patch web-ui/lib/slotScheduler.ts: AcquireSlotOptions gains onWaitRelease/onWaitReacquire hooks; listeners registered on BOTH the fast-path acquire and the queued acquire (fail-before root cause: fast path never registered them, so beginOverlap never fired); notified only by releaseForWait/reacquireAfterWait; cleaned up in the runWithSlot finally.
- Patch web-ui/lib/jobQueue.ts: overlapDepth + activePump seam. beginOverlap() (called from the lease release hook) pumps the next queued job concurrently; endOverlap() on re-acquire. Epochs still serialize (tail chain); the slot arbiter remains the sole serializer of actual LLM dispatches.
- Patch web-ui/lib/chatTurnGate.ts: serializeTurn passes onWaitRelease/onWaitReacquire into runWithSlot and forwards the lease as runTurn(job, worktree, lease).
- Patch web-ui/app/api/chat/route.ts: runTurn forwards the lease to runChatTurn.
- Patch web-ui/tests/hybridCompaction.test.ts: seam import regex widened to accept additional named imports (resolveMidTurnHybridEnabled added alongside resolveCompactionStrategy).
- Wired web-ui/lib/testGate.ts: dedicated #129 rule (conversationCompaction, chat/roundLoop, jobQueue, slotScheduler, chatTurnGate, app/api/chat/route) -> engineSlotReleaseDuringToolWait.test.ts; jobQueue/chatTurnGate rules also include the suite.
- Verification: engineSlotReleaseDuringToolWait 3/0; contextEconomics 15/0; jobQueueIsolation 5/0; jobQueueRoute 11/0; slotScheduler + slotUtilizationMetrics green; hybridCompaction 17/0; turnSurvival 12/0; npx tsc --noEmit clean; npm run test:gate PASSED twice consecutively: 680 tests, 0 failed, ~49s (<90s budget).

## Board #128 (Perf P4) - snapshot interval 5s + pause full-thread polling while streaming

- Worktree: C:\repos\wt-perf-p4, branch feature/perf-p4-snapshot-poll (off fresh origin/develop @ f209f39).
- Test-first: web-ui/tests/snapshotIntervalFiveSeconds.test.ts (4 tests: 5000 ms default constant, throttle skips inside the 5s window and lands past it, forced round-boundary writes still bypass the throttle, route constructs the snapshot with the shared default) and web-ui/tests/streamPollGate.test.ts (6 tests: quiet window equals STREAM_POLL_INTERVAL_MS, delivering/quiet arithmetic incl. boundary + non-finite clock, gate truth table, page.tsx source wiring with no new stream-active state). Both confirmed failing before implementation (default was 1000 ms; lib/streamPollGate.ts did not exist).
- Patch web-ui/lib/streamSnapshot.ts: STREAM_SNAPSHOT_INTERVAL_MS 1000 -> 5000. Round-boundary { force: true } writes unchanged (TURN-LIVENESS contract intact).
- New web-ui/lib/streamPollGate.ts: pure predicate isSseStreamDelivering(lastChunkAtMs, nowMs) + shouldPollLiveThread({ threadLiveStreaming, sseStreamDelivering }); quiet window = STREAM_POLL_INTERVAL_MS (1500 ms). Extracted because app/page.tsx has no browser harness (same pattern as lib/reconcilePollPolicy.ts).
- Patch web-ui/app/page.tsx poll loop: lastStreamChunkAtRef clock refreshed on the existing `messages` state channel (SSE chunks land there via ChatStream's shared setMessages), poll suppressed while the stream is delivering and re-armed on the existing STREAM_POLL_INTERVAL_MS timer once quiet; effect still tears down via the existing streaming/activeTurn gate when the stream ends. No new state channel invented.
- Existing CHAT-8 suites updated to interval-relative timings (chatLiveVisibility.test.ts throttle + interval assertion, chatThinkingPreservation.test.ts throttle window) so they track the new default instead of pinning 1s.
- Wired both new suites into web-ui/lib/testGate.ts MAPPING_RULES with additive rules only (no existing rule edited or removed).
- Verification: snapshotIntervalFiveSeconds 9/0 (incl. streamPollGate run together), streamPollGate 6/0, chatLiveVisibility 8/0, chatThinkingPreservation 4/0, threadStoreCheapSweep/turnLiveness/uirLiveMeter/zombieStreamingCap/observedTurnLiveness/reconcilePollBackoff 47/0; npx tsc --noEmit clean; npm run test:gate PASSED 156/0 across 29 suites, 19.1s (<90s budget).
- Assumption: the brief says gate on the EXISTING stream-active state. page.tsx has no dedicated stream-active boolean; the SSE transport signal is the shared `messages` state that ChatStream writes chunks into, so the gate derives "delivering" from a last-chunk timestamp refreshed on that channel rather than adding a new state.
- Note: .gitignore and web-ui/Dockerfile CR-only churn in this worktree excluded from commits.

## Board #130 (Perf P6) - measure prompt estimate once per round (kill repeated full-history scans)

- Worktree: C:\repos\local-agentic-sandbox\.worktrees\perf-p6, branch feature/perf-p6-estimate-scans (off fresh origin/develop).
- Test-first: web-ui/tests/estimateScanPerRound.test.ts (2 tests: counting observer proves <= 2 array scans per round on the standard path; golden math assertion estimateTokens still ceil(len/4)). Confirmed failing before implementation (setEstimateTokensObserver seam did not exist; standard path re-stringified the full history 8-14x per round).
- Patch web-ui/lib/contextBudget.ts:
  - Added setEstimateTokensObserver(fn|null) test-only seam; estimateTokens invokes it on every call (observer never changes the returned value).
  - estimateEffectivePromptTokens accepts optional precomputedRawMessageTokens to reuse instead of re-stringifying.
  - fitContextWindow accepts optional precomputedRawMessageTokens; reuses it only when consolidation is a no-op (no compactHistory, no stray-system merge), so the fitted array has identical tokens.
  - fitConversationToBudget accepts optional precomputedRawMessageTokens; memoizes the raw working-array estimate with a dirty flag (markDirty) wired into every mutation rung (compaction, elide, drop, truncate) so each mutation re-scans exactly once and a standard no-mutation round reuses the single raw estimate.
  - runChatToolLoop measures rawRoundTokens once per round and threads it through fitConversationToBudget, the continuation contextTokens, and the provider payload fitContextWindow.
- Wired web-ui/lib/testGate.ts MAPPING_RULES with an additive rule only (contextBudget/conversationCompaction/roundLoop/provider/self -> estimateScanPerRound.test.ts); no existing rule edited or removed.
- Provider n_keep only estimates the system-message string (not a full-history array scan), so it is not part of the repeated scans; behavior unchanged there.
- Verification: estimateScanPerRound 2/0; golden suites contextEconomics, prefixReusePreservation, chatContextBudget, chatRoundBudget, chatWebResearchCap, conversationCompaction, hybridCompaction, llmProvider, microElision all UNMODIFIED and green (154 pass / 1 pre-existing skip); npx tsc --noEmit clean; npm run test:gate PASSED 363/0 (<90s budget).
- Assumption: the brief's "at most 2 (one raw, one effective)" bound is enforced on the standard round path (no compaction/elision/directive mutations); mutation rungs re-scan once per mutation via the dirty flag, which is the intended behavior-preserving cost.

## job-132 host-file-restriction-setting (auto-resume attempt 1/2, continued)

- Banked state on resume: worktree D:/AI/orchestrator-scratch/wt-sec-file-restriction on
  feature/sec-file-restriction-setting at origin/develop tip (b64022a), clean tree. Prior
  attempt only created the worktree; no implementation commits existed.
- Worktree had no node_modules; junction-linked repo-root node_modules (web-ui deps live at
  repo root) so tsx tests resolve.
- Test-first: web-ui/tests/hostFileRestriction.test.ts (9 assertions) written before impl;
  confirmed red (MODULE_NOT_FOUND on lib/hostPathRestriction), then green.
- Implementation:
  - web-ui/lib/hostPathRestriction.ts: pure opt-in gate (isPathWithinAllowedFolders via
    path.relative containment - no naive prefix leak; collectPathArguments; evaluateFileRestriction).
  - web-ui/lib/hostSettings.ts: fileRestrictionEnabled (default false) + allowedHostPaths
    (sanitized: trim, dedupe, drop blanks), persisted server-side in host-settings.json.
  - web-ui/lib/hostMode.ts executeHostTool: gate enforced ONLY when toggle ON; blocked calls
    never reach the runner; owner bypass = toggle OFF mid-session stops enforcement instantly.
  - web-ui/app/api/settings/host/route.ts: GET/POST carry the two new fields.
  - web-ui/components/settings/HostZone.tsx: "Host file restriction" switch (aria-checked
    default false) + editable allowed-folders textarea (data-testid host-allowed-paths-editor,
    saves on blur); honest copy "Default is OFF - opt-in, never a mandate".
  - web-ui/components/SettingsView.tsx: handleToggleFileRestriction + handleSaveAllowedPaths
    wired through /api/settings/host.
  - web-ui/lib/testGate.ts: host rule matches hostPathRestriction; manifest includes
    tests/hostFileRestriction.test.ts.
  - web-ui/tests/settingsZoneComponents.test.ts: HostZone props updated for new fields/handlers.
- Targeted gate run: hostFileRestriction + hostSettingsDefault + settingsZoneComponents +
  settingsZones + chunkingSettingsUi + gateManifestCompleteness = 37 pass / 0 fail.
- Assumption logged: restriction scopes host FILE tools + host_run_powershell cwd only;
  unattended git tools carry no path args and stay unrestricted (matches brief: "host file tools").

## Board #131 â€” Security: bind bridge approval tokens to exact tool + payload (PR #236)

- Defect: the bridge only checked the approval-ID format + single-use, so any holder of the shared secret could approve ANY destructive payload with any valid-format ID.
- Fix: host-bridge/approvalToken.ts mints HMAC-SHA256 tokens bound to tool + payload hash (canonical sorted-key JSON), nonce, issuedAt, expiresAt; TTL hard-capped at 5 min (mint throws over the ceiling). verifyApprovalToken constant-time signature check + expiry/over-TTL/malformed rejection. server.ts (/execute + /execute-async) verifies the token against the exact tool+args before execution and consumes by nonce (409 on replay). hostMode.ts mints the bound token from the secret over the final post-dialect-guard args.
- Tests-first: web-ui/tests/approvalTokenBinding.test.ts (8 tests: invented/reused/expired/payload-mismatch/tool-swap/over-TTL rejected; bound token approves exactly once; missing-token 403 preserved). Wired into testGate MAPPING_RULES additively (added to host-bridge rule + new approvalToken rule; no existing rule edited).
- Updated existing approval-gate tests to mint bound tokens: hostDaemon.test.ts (dual-layer gate, recursive-delete), hostAsyncJobs.test.ts (async START gate + replay). hostRunnerScript.test.ts manifest digest regenerated for the new host-bridge source file.
- Verification: approvalTokenBinding 8/0; hostDaemon+hostMode+hostAsyncJobs+chatApprovals green; npx tsc --noEmit clean; npm run test:gate --since=origin/develop PASSED 209/0 (<90s budget).
- Assumption: the brief's referenced spec file (BRIEF-BATCH11-SECURITY-HARDENING-2026-11-20.md) was not present on disk; implemented from the brief's stated goal. Reuse test replays the SAME payload to hit the consumed-nonce 409 path (a replay against a different payload is rejected 403 by signature, which is also correct). Classifier patterns/verdicts untouched; no existing rejection or approval check weakened.

## board #134 Stage 0: reviewer-gate measurement pipeline (PR #245)

- Branch feature/stage0-reviewer-measurement from fresh origin/develop (worktree .worktrees/stage0-reviewer-measurement).
- Test-first: reviewerVerdictParser.test.ts (6), reviewerAuditEvaluate.test.ts (3), orchestratorShadowStages.test.ts +2 - all failed for the stated reasons before fixes.
- Defect 1: parseReviewerVerdictContent strips heading markers (#-######) and bold markers before matching; fail-closed default kept.
- Defect 2: resolveHeadSha (gh pr view --json headRefOid) added to stage deps + orchestrator deps; shadow verdict records 40-char SHA, placeholder recorded with a log note when resolution fails.
- Defect 3: reviewer-audit route POST action 'evaluate' ({pr, brief, allowlist?}) dispatches reviewer thread like issueReviewerThread and records shadow verdict via recordShadowVerdict; returns once recorded (synchronous in-process dispatch, same shape as drain). No merge authority; Stage 3 OFF; isMergeAuthorized unchanged.
- testGate.ts MAPPING_RULES: additive lines only.
- Suites: targeted board/reviewer suites 20/20; gate --since=origin/develop 99 pass / 0 fail; npx tsc --noEmit clean.
- Assumption: gh-level head resolution accepts any non-empty string (preserves existing pollChecks behavior); strict 40-char hex enforced at verdict-recording.

## job-auto-1 (auto-resume attempt 1/2, 2026-11-24 re-verification) - nothing left to do

- Banked state on resume: scope (`parseRetryAfter`, AC-2-1/2-2/2-3) already MERGED via PR #217
  (mergedAt 2026-11-22T23:24:59Z); `web-ui/lib/retryAfter.mjs` and `web-ui/tests/retryAfter.test.ts`
  confirmed present on origin/develop via `git cat-file -e`. No restart, no re-implementation.
- Follow-up (EOL renormalize) already banked: branch `feature/eol-renormalize` @ 1271b44 pushed;
  PR #252 OPEN, MERGEABLE, base develop. Working tree clean apart from 8 untracked
  `eval/results/*` scratch dirs (eval artifacts, out of scope - left untouched).
- Gate re-run on the committed diff: `node scripts/test-gate.js --since=HEAD~1` -> PASSED,
  7 pass / 0 fail in 6.2s (<90s budget). `git diff --ignore-cr-at-eol --stat` -> empty (zero
  content drift; the renormalize commit is pure line-ending normalization).
- Pitfall (self-inflicted, fixed): appending the runlog entry with a PowerShell double-quoted
  here-string swallowed backticks and turned `node` into a newline + `ode`, so CI's
  `Lint & Format` job failed `npx prettier --check .` on `docs/queue-steer-runlog.md` only
  (run 45361657550; all other jobs green). Repair commit `7492eea` rewrites the block via a
  single-quoted here-string + `[System.IO.File]::WriteAllText` (UTF8 no BOM, LF);
  `npx prettier --check docs/queue-steer-runlog.md` -> clean. Rule: never double-quote a
  here-string containing backticks or `\n` - use `@' ... '@`.
- CI on PR #252 @ 7492eea: run 45363575448 conclusion SUCCESS (Lint & Format, Typecheck,
  Unit Tests, Coverage, Playwright shards 1-3, Container Build + Docker Scout all green);
  mergeStateStatus CLEAN, MERGEABLE, OPEN into develop.
- Status: COMPLETE. No further work in scope; PR #252 awaits owner-side merge into develop.

## job-auto-1 (auto-resume attempt 1/2, 2026-11-24 re-verification #2) - scope merged, PR #252 green

- Banked state on resume: scope (`parseRetryAfter`, AC-2-1/2-2/2-3) MERGED via PR #217
  (merge commit `5130bb3` on develop); `web-ui/lib/retryAfter.mjs` and
  `web-ui/tests/retryAfter.test.ts` confirmed present on `origin/develop` via
  `git cat-file -e`. No restart, no re-implementation.
- Follow-up branch `feature/eol-renormalize` @ `f066908` pushed; PR #252 OPEN,
  `mergeStateStatus` CLEAN into develop. CI run 45365584894 conclusion SUCCESS across
  all 8 checks (Lint & Format, Typecheck, Unit Tests & Static Analysis, Coverage,
  Playwright shards 1-3, Container Build + Docker Scout).
- Targeted gate `node scripts/test-gate.js --files=web-ui/tests/retryAfter.test.ts` ->
  PASSED, 14 pass / 0 fail in 5.1s (<90s budget). `npx prettier --check
docs/queue-steer-runlog.md` -> clean. `git diff --ignore-cr-at-eol --stat` -> empty
  (zero content drift; renormalize commit is pure line-ending normalization).
- Working tree clean apart from 8 untracked `eval/results/*` scratch dirs (eval artifacts,
  out of scope - left untouched). develop tip advanced to `ed91eb0` (PR #254 MCP Streamable
  HTTP merged); does not affect this scope.
- Status: COMPLETE. Nothing left in scope; PR #252 awaits owner-side merge into develop.

## board-57 (2026-11-24) - scrub personal names, host paths, banned vendor terms

- Branch `feature/hygiene-scrub-personal-data` rebased onto `origin/develop` (`ed91eb0`).
- Runtime/metadata/comments: `web-ui/app/layout.tsx` metadata already neutral; scrubbed
  personal-name fixtures in `web-ui/tests/userProfile.test.ts`, `operatorMemory.test.ts`,
  `operatorMemoryInjection.test.ts`, `morningReport.test.ts`,
  `dogfoodPhase1Acceptance.test.ts`, `web-ui/scripts/run-dogfood-overnight.ts` (-> "Alex" /
  "Owner" neutral terms).
- Scripts fixtures: `scripts/bench-quality.js`, `scripts/verify-phase-c.js` personal-name
  fixtures replaced with neutral names.
- Host paths: sanitized absolute user-profile path examples in
  `web-ui/components/settings/HostZone.tsx`
  placeholder, `web-ui/lib/activityTimeline.ts` and `web-ui/lib/chatUtils.ts` doc comments;
  committed eval scorecards (`eval/results/baseline-*/endpoint/scorecard.{json,md}`) verified
  clean of absolute user paths (untracked timestamped eval dirs left untouched).
- Banned vendor terms: test descriptions neutralized in
  `web-ui/tests/e2e/layoutInvariants.spec.ts`, `web-ui/tests/mobileHeaderNav.test.ts`,
  `web-ui/tests/llmProvider.test.ts` describe titles.
- Automated hygiene check: `web-ui/tests/repoHygiene.test.ts` detector covers runtime,
  metadata, docs, tests, scripts, eval - flags personal names, absolute user paths, banned
  vendor terms; runs in the `test:gate` suite. Allowlist extended for functional deploy
  manifests (HOST_CHECKOUT_PATH drives the live host runner; prod must stay up - assumption
  logged, out of brief evidence scope).
- Verification: `npx tsx web-ui/tests/repoHygiene.test.ts` -> 0 violations;
  `npm run test:gate` -> PASSED 15/15 in 13.5s.

## job-auto-1 (auto-resume attempt 1/2, 2026-11-24 re-verification #3) - COMPLETE, PR #252 merged

- Banked state on resume: scope (`parseRetryAfter`, AC-2-1/2-2/2-3) MERGED via PR #217;
  `web-ui/lib/retryAfter.mjs` and `web-ui/tests/retryAfter.test.ts` confirmed present on
  `origin/develop` via `git cat-file -e`. No restart, no re-implementation.
- Follow-up PR #252 (`feature/eol-renormalize`) is now MERGED into develop (merge commit
  `09d7626`, mergedAt 2026-11-24T09:54:39Z); renormalize commit `1271b44` confirmed an
  ancestor of `origin/develop` via `git merge-base --is-ancestor`.
- Gate re-run on develop tip: `node scripts/test-gate.js --files=web-ui/tests/retryAfter.test.ts`
  -> PASSED, 14 pass / 0 fail in 8.0s (<90s budget). `npx prettier --check
docs/queue-steer-runlog.md` -> clean.
- develop tip advanced to `dda3602` (PR #262 hygiene scrub merged); does not affect this scope.
- Status: COMPLETE. Scope and follow-up both merged into develop; nothing left in scope.

## #58 Repair testGate ghost paths, dead Playwright rule, unmapped E2E specs, orphaned suites

- Scope: remove 3 ghost test paths (liveStatus/executionSummary/modelEval), fix explorerPanel.spec.ts evaluation order, map remaining Playwright specs, make test-gate --all discover the full set, wire/retire orphaned files, fix host-bridge/package.json test script.
- Changes: web-ui/lib/testGate.ts (ghost removal, explorerPanel rule order, spec mapping rules, discoverAllTests() filesystem discovery, testsOverride, host-bridge:tests + repo-root .js stage); web-ui/scripts/test-gate.ts (--all now seeds discoverAllTests()); web-ui/tests/testGate.test.ts (test-first additions); relocated web-ui/tests-live/board-{intake,orchestrator}.spec.ts -> web-ui/tests/e2e/ (scoped loose getByText to .first() to satisfy strict mode against mobile+desktop duplicate render); host-bridge/package.json test script now runs the real daemon suites in web-ui/tests instead of missing host-bridge/tests/.
- Orphan disposition: scripts/tests/supervisorControl.test.js wired into the gate via a repo-root node --test stage; tests-live/aiLifecycle.live.ts kept as an opt-in destructive lifecycle suite (npm run test:lifecycle), never in the gate.
- Verification: targeted npx tsx --test tests/testGate.test.ts -> 12/12; testGateRunner + gateManifestCompleteness -> 18/18; relocated specs npx playwright test -> 8/8. npm run test:gate -> PASSED 214 tests, 0 failed (<90s budget). The hostRunnerScript.test.ts Test 4 manifest-digest mismatch (84b93... vs computed ff98485...) was caused by this job's own host-bridge/package.json edit (package.json is part of the provenance digest scan); regenerated host-bridge/manifest.json to the deterministic digest -> 5/5 green.
- Auto-resume attempt 2/2: rebased onto origin/develop (4560bccaa4); force-push blocked by dialect guard (prohibition-force-push), so reconciled via a normal merge commit of the remote PR #265 tip (runlog conflict resolved to rebased content). CI run 45483255186 Unit Tests failed: the new host-bridge npm test script ran Windows-dependent daemon suites (engineSlotReleaseDuringToolWait, hostFourState, hostMode, hostSettingsDefault) on Linux runners. Fix: scoped host-bridge/package.json test to the 8 cross-platform daemon suites (approvalTokenBinding, hostAsyncJobs, hostDaemon, hostGitSafetyBattery, hostMultiRead, hostRunnerScript, patchTools, unattendedGitOps) -> host-bridge npm test 94/0; manifest digest regenerated (34bf2b71...). Gate re-run: PASSED 188/0. Flaky note: chunkingSettings Test 4 fails intermittently under concurrent gate runs (shared host-settings.json state contention); passes in isolation and on gate re-run — pre-existing flake, out of scope.

## #122 Stability and install: atomic checkpoints, durable run ledger, bounded trace store, installable manifests

- Brief (truth pass Nov 25, 2026 vs develop de2184da): Defect 1 (atomic checkpoint writes + corrupt-file quarantine) and Defect 2 (RUN_LEDGER_DB_PATH / USER_PROFILE_PATH on PVC) verified already fixed on develop - not redone. Defect 4 (machine-local paths): no developer-machine absolute paths found in the named areas; verdict recorded in PR body with evidence.
- Defect 3 (DONE): web-ui/lib/telemetry.ts traceStore was an unbounded Map despite the documented 'last 50' cap. Added MAX_TRACE_SESSIONS = 50 and enforceTraceStoreCap() (oldest-first eviction by startTime, applied on every session insert); exported getTraceStoreSize(). Test-first: web-ui/tests/telemetry.test.ts gained 'trace store enforces the documented cap of 50 sessions, evicting oldest first' and 'an evicted session lookup behaves sanely' (both failed before the fix, pass after). Targeted run: 7/7.
- Defect 5 (DONE): deploy/k8s/kustomization.yaml omitted strata-service.yaml and host-runner-service.yaml (web-ui.yaml env endpoints LLM_BASE_URL/HOST_RUNNER_URL reference them). Added both; kubectl kustomize deploy/k8s now renders the full topology (11 Services incl. strata-service, host-runner-service). New web-ui/tests/kustomizeManifests.test.ts (3 tests, failed before fix, pass after) pins resource-set membership + endpoint resolution; wired into testGate MAPPING_RULES. Helm chart deploy/helm removed rather than brought to parity: it was stale (no pvc-workspace mount, no host service endpoints), unconsumed by any deploy path (canonical path is scripts/deploy-cluster.js + kustomize), and docs/KUBERNETES_DEPLOYMENT.md already declared it non-canonical. mcp-server/tests/networkPoliciesConfig.test.ts retargeted to the canonical deploy/k8s/network-policies.yaml (3/3). Docs updated: README, ARCHITECTURE, SECURITY, KUBERNETES_DEPLOYMENT, bug-report template, .prettierignore, eslint.config.mjs.
- Commits on feature/stability-install-trace-cap-and-manifests: 2e85362c53 (trace cap), b0fb2432fb (helm removal), 81ec20d0b5 (kustomize + manifest tests + docs).

## #124 Board item delete and edit (remainder) - Nov 25 2026

- Branch feature/board-item-delete-guard-and-confirm (worktree D:\AI\orchestrator-scratch\wt-124-board-delete).
- Tests first: web-ui/tests/boardDeleteGuard.test.ts - store remove guard (working refused, item survives), DELETE route 409 for working + 200/404 unchanged, UI confirmation flow (no DELETE before confirm, DELETE after confirm, cancel sends nothing), working-item delete unavailable with reason. 6/6 green.
- Impl: BoardStore.remove throws on status=working; DELETE route maps that to 409; BoardView Delete button now opens inline confirm ('permanently removed and cannot be undone') with Confirm/Cancel; working items show disabled 'Delete unavailable - job is running'.
- Targeted suites (boardStore, boardUi, uiClosures) 24/24 green; tsc --noEmit clean.

## job-135 (auto-resume attempt 1/2) #135 tool-call integrity: markup fence + zero-trace tripwire

- Resume state: worktree `repos\integrity-135-wt` on `feature/tool-call-integrity-fence-tripwire` at develop tip, clean tree, no job commits banked.
- Core scope already merged into develop by earlier PRs: `web-ui/lib/toolCallIntegrity.ts` (markup detector, repair directive, honest marker, zero-trace tripwire), wired in `web-ui/lib/chat/roundLoop.ts` (markup fence ~line 1556-1583; tripwire ~line 2939-2970), UI badge `web-ui/components/CompletionVerificationBadge.tsx` (data-testid `completion-unverified-badge`).
- Gap per brief: stubbed-stream integration test. Added `web-ui/tests/toolCallIntegrityStream.test.ts` (4 tests): markup-as-text -> exactly one repair re-prompt then honest marker + status `incomplete`; normal tool round untouched (no repair directive); zero-trace claim stamped `completed-unverified` with `zero_traces` gap; traced turn never stamped unverified (direct `runChatTurn` harness with fake tool client).
- Env note: fresh worktree had no node_modules; `npm install` failed on root husky `prepare` hook -> used `npm install --ignore-scripts`.
- Verification: `tsx --test tests/toolCallIntegrityStream.test.ts` 4 pass; `toolCallIntegrity.test.ts` + `invariantNetA3.test.ts` 21 pass; `tsc --noEmit` clean.

## job-138 #138 context sheet: tap the context meter for usage details and compact

- Worktree on feature/context-meter-sheet (from origin/develop tip 6882da384f). node_modules junctioned from host checkout (fresh worktree had none).
- Tests first: web-ui/tests/contextSheet.test.ts (12 tests, repo source-string style like uirLiveMeter): pill renders as <button>; tap opens sheet with used/budget/percent/free from state; 85K rose tick; three segment rows; last-round + compaction chips; Compact calls POST /api/threads/<id>/compact via handleManualCompact and reflects compacting state; Restore hidden without boundary, present with one; Compact disabled while a turn streams with reason. Segment/count derivation unit tests on lib/contextSegments.ts.
- Impl: web-ui/lib/contextSegments.ts (deriveContextSegments + countCompactions from existing estimateTokens/per-message/per-trace estimates, no new accounting); web-ui/components/ContextSheet.tsx (one component: bottom sheet <md, centered dialog >=md; pure #000 canvas, emerald accent only, rose only for 85K tick, zinc-300 text, 44px touch targets); ChatStream.tsx pill div -> button (data-testid context-meter-pill kept, min-h-[44px], aria-haspopup dialog) opening showContextSheet; sheet mounted with existing handleManualCompact/handleRestoreCompaction/threadCompaction/isTurnLive/isCompactingManually; desktop overflow item unchanged.
- MAPPING_RULES: additive rule mapping ContextSheet/contextSegments/ChatStream/contextSheet.test.ts -> tests/contextSheet.test.ts.
- Contrast audit fix: ContextSheet text-zinc-400 -> text-zinc-300 (Design Lock #3 bans unprefixed text-*-400; brief allows zinc-400 or brighter).
- Verification: tsx --test tests/contextSheet.test.ts 12/12 green; tsc --noEmit clean; test:gate --since=origin/develop: 601 passed, 0 test failures - the single gate FAILED line is the gate npm run build step hitting an environmental EPERM scandir on an engine-held temp dir (temp dir lock), not a compile error; reproduced identically twice, unrelated to this job code.

## Board #139 - /compact slash command in the composer

- Branch: feature/composer-compact-slash-command (from origin/develop).
- Test-first: web-ui/tests/compactSlashCommand.test.ts written before implementation; red on first run (module missing), green after implementation (9 pass / 0 fail).
- Implementation:
  - web-ui/lib/chat/compactCommand.ts - isCompactCommand(): exact trimmed, case-insensitive /compact only.
  - web-ui/components/ChatStream.tsx - handleManualCompact refactored into shared runManualCompaction() verdict path (POST /api/threads/<id>/compact); handleSend intercepts exact /compact BEFORE decideSendAction dispatch: mid-turn refusal uses the ContextSheet unavailable reason, empty thread shows 'Nothing to compact yet' and never calls onEnsureThread, success shows tokens before -> after in an in-place composer notice (data-testid=compact-command-notice), failure restores composer text intact for retry. No user message appended, no turn started.
  - web-ui/lib/testGate.ts - additive MAPPING_RULES entry mapping lib/chat/compactCommand + components/ChatStream to tests/compactSlashCommand.test.ts.
