# Queue Steer Runlog

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
