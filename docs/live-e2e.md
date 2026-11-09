# Live Acceptance Test Suite (`test:e2e:live`)

## Overview

The `test:e2e:live` suite provides an end-to-end acceptance battery executed directly against the real local cluster stack, deployed containerized `web-ui`, Strata LLM inference engine, and the host-bridge runner daemon.

Unlike the deterministic mock/stub suite (`npm run test:e2e` / `npm run test:ui`) which intercepts routes against a fast mock engine on port 11435, `test:e2e:live` validates that the live model, context budgets, compaction pipelines, host-bridge permissions, and client-side UI rendering behave cohesively under actual LLM inference workloads.

---

## Execution Command

From repository root:
```bash
npm run test:e2e:live
```

Or from `web-ui/`:
```bash
npm --prefix web-ui run test:e2e:live
```

---

## Prerequisites & System-Under-Test Requirements

This suite is strictly local-only and intended for on-device acceptance verification before releasing or promoting changes. It does not run in GitHub Actions / CI runners because it requires:

1. **Local Kubernetes Cluster (KinD):**
   - Active `local-agentic-sandbox` namespace.
   - Deployed `web-ui` container accessible on `http://192.168.50.254` (or overridden via `PLAYWRIGHT_LIVE_BASE_URL`).
2. **Strata LLM Engine:**
   - Active on `http://127.0.0.1:8080`.
   - Single-slot concurrency (`workers: 1` enforced to prevent slot queue contention).
3. **Host Runner Daemon:**
   - Active on `http://127.0.0.1:8765`.
   - Configured with matching shared secret.

---

## Spec Battery Breakdown

| Spec | Target Validation | Class Deadline |
|---|---|---|
| **L1 (`l1-short-flow-copy.spec.ts`)** | Weather search turn, instant user prompt copy affordance ("Copied" feedback), and contextual multi-turn reasoning. | NORMAL (3m) |
| **L2 (`l2-artifacts-downloads.spec.ts`)** | HTML landing page with inline `<svg>` rendering sandboxed iframe with 0 vector card hijacking and `.html` download; pure SVG vector graphic; and Draw.io XML conversion. | NORMAL (3m) |
| **L3 (`l3-compaction-numbers.spec.ts`)** | Programmatic filler rounds crossing 85K compaction threshold; verifies UI `Compacted` pill with `X → Y` token metrics; gist recall of unique seeded credentials; zero unexpected pod restarts. | HEAVY (6m) |
| **L4 (`l4-steer-reload-resilience.spec.ts`)** | Mid-stream redirection via `POST /api/threads/[id]/steer` with stream interruption; survives browser page reload mid-stream; zero duplicate user prompts. | HEAVY (6m) |
| **L5 (`l5-host-multi-slice.spec.ts`)** | Multi-slice host tool orchestration; writes 3 discrete files to `C:\AI\scratch\`; reads back via host tools; validates exact byte contents on host filesystem. | HEAVY (6m) |
| **L6 (`l6-long-generation.spec.ts`)** | Deep-dive streaming architecture spec (>4,000 tokens / >16,000 characters); verifies clean completion status with zero truncation markers. | WEDGING_LIMIT (8m) |
| **L7 (`l7-host-stress.spec.ts`)** | Uncapped host file reads (>70KB payload); verifies PowerShell tool output >75KB is clamped at 64KB boundary with honest truncation metadata; completes cleanly. | HEAVY (6m) |
| **L8 (`l8-wedge-regression.spec.ts`)** | Single massive tool argument regression test; verifies Strata slot 0 is not wedged when model handles massive argument strings. | WEDGING_LIMIT (8m) |

---

## Preflight & Watchdog Protection

Before any test begins:
- `globalSetup.ts` verifies:
  1. UI endpoint health.
  2. Deployed container image tag.
  3. Pod restart count baseline.
  4. Strata slot 0 is idle (`is_processing: false`).
  5. Host runner daemon health.
- Between every spec, `checkEngineWatchdog()` ensures Strata slot 0 returned to idle before the next test starts.
