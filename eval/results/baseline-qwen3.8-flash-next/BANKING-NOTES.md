# Baseline Banking Notes — qwen3.8-flash-next-gyro-gyro-s

- **Pack**: v1.0.0 (`eval/pack.json`), pass bars unmodified.
- **Engine**: `qwen3.8-flash-next-gyro-gyro-s` served locally at
  `http://127.0.0.1:8080/v1`.
- **Date**: 2026-11-20 (America/Chicago, overnight).
- **Banked from**: endpoint run `2026-11-20T09-31-41-438Z` (complete, exit 0);
  job-mode runs listed below.

## Endpoint mode — 3/5 PASS

| Task                 | Verdict | Duration | Note                                                                                             |
| :------------------- | :------ | -------: | :----------------------------------------------------------------------------------------------- |
| forensic-diagnosis   | PASS    |    94.9s | All 3 root-cause keywords; no false fix claim                                                    |
| pr-coding            | FAIL    |    98.6s | Produced module does not export the required `parseRetryAfter` name; hidden tests fail at import |
| synthesis-honesty    | PASS    |    19.9s | 3/3 resolvable citations                                                                         |
| tool-discipline      | FAIL    |     7.0s | No tool call executed and no honest stall marker under the injected stall                        |
| compaction-retention | PASS    |   260.6s | 5/5 identifiers retained; retention ratio 0.554 vs Arm A reference 0.545                         |

Slot metrics for the endpoint run (from `endpoint/scorecard.json`):
slot utilization 100% during the run window, 0 preemptions, owner wait
p50/p95 = 0ms with n=0 (endpoint mode has no interactive owner contention;
these numbers describe the eval window only, not production traffic).

## How the endpoint run was obtained (method disclosure)

`eval/run.mjs` issues non-streaming fetches and inherits Node's default
300s headers timeout, and it has no per-task fault isolation: one timed-out
task aborts the whole run with no scorecard. Two full-pack attempts died
that way on 2026-11-20:

1. Run `2026-11-20T08-55-12-995Z` — died at `pr-coding` under heavy host
   load (concurrent image build + full test suites).
2. Run `2026-11-20T09-11-30-055Z` — banked 4 traces, then died at
   `compaction-retention`. That task's generation legitimately takes
   ~260-325s on this engine (measured twice), i.e. just over the default
   client timeout.

The banked run was executed with an operator preload
(`node --import eval-preload.mjs`) that replaces the HTTP client's global
dispatcher with identical settings except headers/body timeouts raised to
1800s. Prompts, request payloads, grading, and pass bars were not touched.
A solo `compaction-retention` run (`2026-11-20T09-23-49-461Z`, PASS,
323.2s, 5/5 identifiers, ratio 0.556) corroborates the full-run result.

Recommended pack hardening (requires a pack version bump): stream
responses or raise the client timeout in the runner, and isolate per-task
failures so one timeout cannot void a run.

## Job mode

- `pr-coding --chunk-rounds 8`: attempted twice (threads
  `thread-1795167630485-c0hv`, `thread-1795167759988-iy0w`). Both failed at
  the planning stage before any execution: `Invalid PlanSpec: planner
produced empty milestones.` The failure surfaced loudly on the thread
  (status `failed`, reason shown) — no silent ghost. Against
  `eval/CHUNKED-BASELINE.md`: deliverable not completed, no chunk commits
  or handoffs produced, no continuations ran — the chunked criteria cannot
  be evaluated because the job never entered execution. Recorded as a
  job-mode FAIL for this baseline and as a planner-robustness finding for
  small single-file goals.
- `--mode job --all`: launched 2026-11-20 03:44 CT (run
  `2026-11-20T09-44-41-242Z`); completed the same night with exit 1.
  Its first job (forensic-diagnosis, thread
  `thread-1795167881268-3mve`) accepted a 4-milestone plan and executed:
  pod logs show milestone M1's builder returning a diff, the test runner
  failing it (1 test), the critic returning `needs_fix`, and a fix round
  starting. The thread then ended with status `stopped` about 11 minutes
  in, mid-fix-round, with no stop reason recorded on the thread and no
  deliverable. The runner recorded the failure trace
  (`job/forensic-diagnosis.trace.json`) and aborted, so the remaining
  four job-mode tasks never ran — the same no-per-task-isolation flaw as
  endpoint mode. Recorded as a job-mode FAIL for forensic-diagnosis and
  "not run" for the other four tasks in job mode. Two findings follow:
  a stopped job should carry its stop reason on the thread, and the
  runner needs per-task isolation in both modes.

## Grader integrity

`web-ui/tests/evalPackGraders.test.ts` and
`web-ui/tests/evalRunnerJobMode.test.ts` pass (7/7) on the same code the
runs were executed against.
