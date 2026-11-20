# Stage-Flip Evidence Bundle — v3 (assembled 2026-11-20)

Purpose: the evidence base for the owner's explicit decisions on (1) enabling
board stage flags (flow-monitor Stage 2, reviewer-gate Stage 3, self-deploy)
and (2) promoting develop to main. All stage flags remain OFF. Nothing in this
bundle flips a flag or promotes a branch; those are owner decisions.

## 1. What is live on develop + prod (verified 2026-11-20, prod == develop 3c2a5ea)

- ITEM-1 observability, ITEM-2 execution path, ITEM-3 board ghost fix,
  ITEM-4 PrioritySlotScheduler, ITEM-5 slot telemetry, ITEM-6 Start/Pause/Stop,
  ITEM-7 BoardOrchestrator, ITEM-8 monster-prompt intake: all merged and
  deployed Nov 18, 2026 (PRs #155-#162), S4-verified.
- ITEM-9 shadow wiring (PR #165, merged Nov 20, 2026, develop 3c2a5ea,
  prod image v-3c2a5ea-mworl3g1): flow-monitor, reviewer-gate, and
  self-deploy stages wired into the orchestrator's post-PR lifecycle in
  shadow mode. All stage flags default OFF (env BOARD_STAGE_FLOW_MONITOR /
  BOARD_STAGE_REVIEWER_GATE / BOARD_STAGE_SELF_DEPLOY, value "true" only).
  Reviewer results are forced mergeAuthorized:false while Stage 3 is off.
  Self-deploy returns "shadow_prepared" and executes no deploy step while
  its flag is off. GET/POST /api/board/reviewer-audit live in prod (200).
- Test guards dropped by the Nov 18-19 visual redesign restored (PR #164).

## 2. Eval baseline (PROOF-3.3)

- Pack v1.0.0, engine qwen3.8-flash-next-gyro-gyro-s, endpoint mode --all.
- Grader/runner unit checks: evalPackGraders + evalRunnerJobMode — 7/7 pass
  (run 2026-11-20 in the ITEM-9 worktree).
- Endpoint scorecard (run 2026-11-20T09-31-41-438Z, banked in
  eval/results/baseline-qwen3.8-flash-next/): **3/5 PASS** —
  forensic-diagnosis PASS (94.9s), synthesis-honesty PASS (19.9s),
  compaction-retention PASS (260.6s, 5/5 identifiers, ratio 0.554 vs
  reference 0.545); pr-coding FAIL (model's module did not export the
  required `parseRetryAfter` name; hidden tests fail at import);
  tool-discipline FAIL (no tool call executed and no honest stall marker
  under the injected stall).
- Runner caveat (measured): eval/run.mjs issues non-streaming fetches with
  Node's default 300s headers timeout and has no per-task isolation; two
  baseline attempts died on single-task timeouts (run 1 at pr-coding under
  heavy host load; run 2 at compaction-retention, whose generation
  legitimately takes ~260-325s on this engine). Final run used an operator
  preload raising the client dispatcher timeout to 1800s; prompts, payloads,
  and grading untouched. Pack hardening (streaming + per-task isolation +
  configurable timeout, with pack version bump) is recommended follow-up.
- Job mode: pr-coding --chunk-rounds 8 FAIL before execution, twice —
  the task planner produced an empty milestone plan for the frozen
  pr-coding goal (`Invalid PlanSpec: planner produced empty milestones`),
  surfaced loudly as a failed thread both times. CHUNKED-BASELINE criteria
  are not evaluable (no deliverable, chunks, or continuations — the job
  never entered execution). Recorded as a planner-robustness finding for
  small single-file goals. Job-mode --all completed the same night: its
  forensic-diagnosis job accepted a 4-milestone plan, executed into a
  test-failure/critic fix loop on milestone 1, then ended `stopped`
  about 11 minutes in with no stop reason recorded on the thread and no
  deliverable; the runner aborted on that first job, so the other four
  job-mode tasks never ran. Details in the baseline BANKING-NOTES.md.

## 3. Release Bar status (STAGE-3.4)

- Release Bar Option A (3 consecutive unattended in-app PRs [docs, code,
  test] + 1 deliberately failing job landing in needs-attention): NOT YET
  DEMONSTRATED. The Nov 18-20 PRs (#155-#165) were driven through the
  external operator circuit (brief -> builder run -> CI -> audit -> merge ->
  deploy -> S4), not through unattended in-app board drains. The in-app
  pipeline machinery (ITEM-7 orchestrator + ITEM-9 shadow stages) is live;
  the unattended-drain proof is still outstanding.
- Agreement ledger: 0 comparisons accumulated. ITEM-9's ledger starts empty;
  >=10 shadow reviewerGate comparisons with >=95% agreement and 0 escapes
  are required before stage3Eligible can read true. Accumulation requires
  production drain wiring (real gh polling + reviewer-thread deps in the
  drain route) plus real PR flow through drains — future work, owner-paced.

## 4. Decisions requested of the owner

1. Stage 2 (flow-monitor): flip BOARD_STAGE_FLOW_MONITOR after production
   drain deps are wired? (Not flippable meaningfully before.)
2. Stage 3 (reviewer-gate): remains OFF until the >=10 / >=95% / 0-escape
   evidence exists — no decision needed yet.
3. Self-deploy stage: remains OFF (shadow_prepared) — no decision needed yet.
4. develop -> main promotion: owner's call, separate from stage flags.

## 5. Open risks / follow-ups

- Tool-call integrity (UI-101, Nov 20, 2026): a chat turn claimed a search
  outage that never happened — model-side tool-call emission failure with a
  confabulated failure narrative; zero-trace tripwire not yet built
  (sprint item 15).
- Eval pack runner hardening (see 2).
- WS2 / WS3 remain design-only, owner-gated builds.
