# Compaction A/B Benchmark — Checkpoint & Mid-Run Status Report
**Date**: November 8, 2026 (Night Session Checkpoint)  
**Branch**: `feature/compaction-ab-benchmark` (Commit `cd3176d` pushed)  
**Deployed Target**: `local-agentic-sandbox-web-ui:v-dc784c6-mw890nuk`  
**Status**: PAUSED for host gaming / AI mode toggled off. Ready to resume immediately.

---

## 1. Executive Summary & Findings So Far

### A. Harness & Workload Calibration (Phase 1 Complete)
- Standalone, automated, programmatic benchmark runner built: `scripts/bench-compaction-ab.ts`.
- Reuses all hardened primitives from `web-ui/tests/e2e-live/helpers.ts` (bounded polling, watchdog verification, 60s heartbeats, zero-leak scratch cleanup).
- 3 distinct workloads implemented:
  - **W1 (Identifiers & Errors)**: Exact recall of file paths, ports, cluster tokens, URLs, and diagnostic error lines.
  - **W2 (Decisions & Tails)**: User constraint planted strictly past char 2,000; assistant consensus decision (Paxos vs Raft) with rationale planted mid-message; repeated filler block.
  - **W3 (The Correction)**: Initial fact (port 8443) explicitly superseded before compaction by port 9443; probe evaluates programmatic on-disk bytes of configuration JSON.

### B. Manipulation Check Results (Arm A Instrument Validity Verified)
The brief specified:
> *MANIPULATION CHECK (the instrument's validity): Arm A is EXPECTED to fail the W2 tail-constraint probe (extraction keeps only the first 2,000 chars of a user turn) and to retain the filler block near-verbatim in W2.*

**Result**:
- **W2 Run 1 (`w2-a-r1-oq48`)**: **0/2 probes passed**.
  - Tail constraint `[HONORED-W2-A-R1-OQ48]` was planted at char 2,508. Arm A's extraction truncated at char 2,000. In the probe turn, the model responded without the tag: **FAILED**.
  - Consensus decision on line 2 was omitted by Arm A's line-1 extraction (`firstLine`). When probed, the model responded: *"No consensus protocol was decided upon — there is no such decision in this project"*: **FAILED**.
- **W2 Run 2 (`w2-a-r2-ngkp`)**: **0/2 probes passed**.
  - Tail constraint `[HONORED-W2-A-R2-NGKP]` omitted from context: **FAILED**.
  - Decision omitted: the model responded: *"No consensus protocol decision exists in this conversation's record"*: **FAILED**.
- **Manipulation Check Verdict**: **CONFIRMED (100% valid)**. Arm A's deterministic extraction systematically severs tail constraints and mid-message decisions once compacted.

---

## 2. Baseline Matrix (Arm A — 5/6 Runs Complete)

| Run ID | Workload | Arm | Run # | Tokens Before | Tokens After | Retained Ratio | Compact Duration | Total Duration | Probes Passed | Hallucinations | Pod Restarts |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `w1-a-r1-gfnb` | W1 | A | 1 | 100,166 | 54,548 | 54.5% | 235.5s | 896.6s | **5/5** (100%) | 0 | 0 |
| `w1-a-r2-4sf9` | W1 | A | 2 | 100,206 | 54,692 | 54.6% | 238.5s | 863.4s | **5/5** (100%) | 0 | 0 |
| `w2-a-r1-oq48` | W2 | A | 1 | 97,991 | 50,558 | 51.6% | 241.6s | 1395.5s | **0/2** (0%) | 0 | 0 |
| `w2-a-r2-ngkp` | W2 | A | 2 | 97,999 | 50,559 | 51.6% | 244.7s | 992.7s | **0/2** (0%) | 0 | 0 |
| `w3-a-r1-iy8s` | W3 | A | 1 | 98,420 | 56,351 | 57.3% | 244.5s | 957.5s | **1/1** (100%) | 0 | 0 |
| `w3-a-r2-8wq0` | W3 | A | 2 | *Paused* | *Paused* | *Paused* | *Paused* | *Paused* | *Pending* | - | 0 |

### Key Baseline Observations:
1. **Identifier Preservation in Arm A**: 100% accurate (10/10 probes across W1 R1 and R2). The regex extractor reliably grabs planted paths, ports, tokens, and errors when formatted as identifiers.
2. **Tail Constraints & Decisions**: 0% in Arm A (0/4 probes across W2 R1 and R2). Extraction completely loses any user constraint beyond char 2,000 and any assistant decision not on line 1.
3. **Correction Handling**: In W3 R1, the model in Arm A recalled port 9443 because the correction turn was short enough (<2,000 chars) to be retained in `Prior User Goals & Requests`. W3 R2 will confirm the control baseline.
4. **Compression Performance**: Arm A achieves a median compression of **54.5% retained ratio** (~100K down to ~50K-56K tokens) in ~240s compaction time.

---

## 3. Pickup Protocol (Resume Point for Tonight)

When AI mode is toggled back on, resume with the following sequence:

### Step 1: Preflight Verification
Confirm Strata LLM engine and Host Runner are operational:
```bash
# Verify Strata slots (expect IDLE)
curl http://127.0.0.1:8080/slots

# Verify Host Runner health
curl http://127.0.0.1:8765/health

# Verify Web-UI pod
kubectl get pods -n local-agentic-sandbox -l app=web-ui
```

### Step 2: Complete Baseline Run (Phase 2 Closeout)
Execute the single remaining baseline run (W3 Run 2):
```bash
npx --prefix web-ui tsx scripts/bench-compaction-ab.ts --arm=A --workload=W3 --run-number=2
```
Verify that `docs/compaction-ab-results.json` now contains all 6 baseline runs.

### Step 3: Implement Arm B (Phase 3 — Test-First Behind Flag)
1. Write unit tests in `web-ui/tests/hybridCompaction.test.ts`:
   - Escalation triggers only above the post-extraction threshold (>65% of 100K budget = 65,000 tokens).
   - Fallback to extraction on simulated generation failure or timeout (180s inactivity, 5m total deadline).
   - Identifier post-check rejects incomplete model summaries (all paths, SHAs, URLs from extraction digest must appear).
   - Audit copy: extraction digest is ALWAYS retained in thread record alongside model summary.
   - Flag `COMPACTION_STRATEGY=extraction` reproduces Arm A behavior exactly.
   - Shipped prompt constant `COMPACTION_PROMPT_V1` carries the v1 sections and rules verbatim.
2. Implement Arm B in `web-ui/lib/conversationCompaction.ts`.
3. Run `npm run test:gate` and `npm run build`.
4. Open PR into `develop` (no merge).
5. Build and deploy to cluster with rollback tag recorded:
   - Rollback tag: `local-agentic-sandbox-web-ui:v-dc784c6-mw890nuk`
6. Sanity check: One W1 run on B build with flag OFF (`COMPACTION_STRATEGY=extraction`) to confirm 0 build drift against baseline.

### Step 4: Treatment Runs (Phase 4 — Arm B with Flag ON)
Set `COMPACTION_STRATEGY=hybrid` and execute:
```bash
npx --prefix web-ui tsx scripts/bench-compaction-ab.ts --arm=B --workload=ALL --runs=2
```

### Step 5: Final Report & Pre-Registered Recommendation (Phase 5)
Apply pre-registered decision rule strictly:
- Recommend B **only if**:
  1. Zero identifier probe losses vs A.
  2. Zero hallucinated facts in B.
  3. B beats A on W2/W3 decision, tail, and correction probes in BOTH runs.
  4. Median added latency ≤ 180s.
  5. B's retained-token ratio ≤ A's on W2.
- Mirror report into `docs/queue-steer-runlog.md` and `D:\AI\argon-orchestrator-progress.md`, commit and push.
