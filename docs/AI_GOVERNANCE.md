# Enterprise Agentic AI Governance Specification

**Repository:** `local-agentic-sandbox`  
**Standard Alignment:** NIST AI RMF 1.0 (`GOVERN`, `MAP`, `MEASURE`, `MANAGE`), OWASP Top 10 for Agentic Applications 2026 (`ASI01`–`ASI05`), EU AI Act Articles 12 & 14  
**Classification:** Architecture & Security Specification

---

## 1. Executive Summary: Deterministic Enforcement Over Probabilistic Prompts

Because Large Language Models are non-deterministic, system prompts cannot serve as security, integrity, or compliance boundaries. A prompt instructing an agent to *"never access unauthorized files"* or *"be honest and do not fabricate tests"* can be circumvented via prompt injection, jailbreaks, context drift, or model hallucination.

`local-agentic-sandbox` implements Enterprise AI Governance as **deterministic runtime enforcement** across five architectural layers:
1. **OS Kernel & Container Boundary:** Unprivileged user execution (`UID 10001`), immutable root filesystem (`readOnlyRootFilesystem: true`), dropped Linux capabilities (`CAP_DROP ALL`), `no-new-privileges: true`, and zero access to container sockets (`/var/run/docker.sock`).
2. **Kubernetes Network Plane:** Default-deny `NetworkPolicy` isolating the agentic AI mesh (`ai-mesh`), blocking arbitrary Internet egress, and neutralizing Server-Side Request Forgery (SSRF) against private RFC 1918 subnets and cloud metadata endpoints (`169.254.169.254`).
3. **Compiler & AST Validation:** Pre-write Abstract Syntax Tree (AST) compilation checks ensuring syntactically well-formed deliverables prior to disk writes, paired with regex complexity analysis preventing Regular Expression Denial of Service (ReDoS).
4. **Git Subprocess & Branch Boundary:** Array-safe subprocess execution (`execFile`) eliminating shell injection, strict commit scoping refusing un-tracked tree staging, and protected branch gates prohibiting modifications to production branches (`main`, `master`, `develop`, `production`).
5. **Durable Ledger, Provenance & Human Gate:** SQLite-backed append-only execution ledger recording cryptographic commit SHAs and reasoning traces, coupled with a mandatory 3-observation human approval gate before any learned pattern is promoted into active memory.

---

## 2. Framework Alignment Matrix: NIST AI RMF 1.0 & OWASP Top 10 for Agentic Applications

The following governance control matrix maps enterprise compliance requirements directly to deterministic enforcement modules in this repository:

| Framework & Threat ID | Threat Name / Domain | Deterministic Enforcement Mechanism | Codebase Link |
| :--- | :--- | :--- | :--- |
| **OWASP ASI01**<br>**NIST MANAGE 2.4** | **Agent Goal Hijack & Sycophantic Drift**<br>Adversarial prompts, indirect prompt injection, or sycophantic alignment forcing agents off-course. | **Role-Separation & Ground-Truth Test Override:**<br>1. `BuilderWorker` cannot self-approve; independent `CriticWorker` audits deliverables.<br>2. `runSycophancyProbe` audits critic independence at worker initialization.<br>3. Ground-truth test override: failing test suites deterministically reject milestones prior to invoking the model. | [`web-ui/lib/subagents/workerPool.ts`](../web-ui/lib/subagents/workerPool.ts)<br>[`web-ui/lib/subagents/supervisor.ts`](../web-ui/lib/subagents/supervisor.ts) |
| **OWASP ASI02**<br>**NIST MEASURE 2.7** | **Tool Misuse & Subprocess Exploitation**<br>Arbitrary command injection, shell metacharacter expansion, and runaway AST syntax errors. | **Argv-Safe Execution & Pre-Write AST Check:**<br>1. `execFile` array arguments with zero shell interpolation.<br>2. Protected branch guards blocking `main`, `master`, `develop`, and `--force` flags.<br>3. `validateCodeAst` verifies TypeScript/JavaScript/Python syntax prior to file writing.<br>4. `validateRegexPattern` guards against ReDoS catastrophe. | [`web-ui/lib/git/workerGitOps.ts`](../web-ui/lib/git/workerGitOps.ts)<br>[`web-ui/lib/deploy/selfDeploy.ts`](../web-ui/lib/deploy/selfDeploy.ts)<br>[`mcp-server/src/tools/workspaceTools.ts`](../mcp-server/src/tools/workspaceTools.ts) |
| **OWASP ASI03**<br>**NIST MAP 3.5** | **Identity & Privilege Abuse / Container Breakout**<br>Container escapes, SSRF pivoting, lateral network movement, and host filesystem takeover. | **Least-Privilege Pod Security & Air-Gapped Egress:**<br>1. Unprivileged container execution (`UID 10001:10001`), `readOnlyRootFilesystem: true`, `cap_drop: ALL`.<br>2. Omission of `/var/run/docker.sock` (`CWE-250` breakout prevention verified via attestation).<br>3. Default-deny Kubernetes `NetworkPolicy` restricting mesh egress.<br>4. SSRF blocklists intercepting RFC 1918 and `169.254.169.254` targets. | [`deploy/k8s/mcp-runner.yaml`](../deploy/k8s/mcp-runner.yaml)<br>[`deploy/k8s/network-policies.yaml`](../deploy/k8s/network-policies.yaml)<br>[`mcp-server/src/tools/attestation.ts`](../mcp-server/src/tools/attestation.ts)<br>[`browser-mcp/src/tools/browser.ts`](../browser-mcp/src/tools/browser.ts) |
| **OWASP ASI04**<br>**NIST MANAGE 4.1** | **Unbounded Consumption & Runaway Loops**<br>Stuck compilation loops, hallucinated circular retries, and GPU VRAM exhaustion. | **3-Strike Stuck Detection & Baseline Revert:**<br>1. Consecutive error signature normalization (`normalizeErrorSignature`) breaks loops at 3 identical errors.<br>2. Blocking-gate regression checks (`compareAndRevertIfWorse`) revert regressions to baseline.<br>3. Exponential backoff auto-disable for scheduled cron jobs after 5 consecutive failures.<br>4. 16GB VRAM residency governor enforcing local memory leases. | [`web-ui/lib/subagents/workerPool.ts`](../web-ui/lib/subagents/workerPool.ts)<br>[`web-ui/lib/subagents/scheduler.ts`](../web-ui/lib/subagents/scheduler.ts)<br>[`web-ui/lib/subagents/residency.ts`](../web-ui/lib/subagents/residency.ts) |
| **OWASP ASI05**<br>**EU AI Act Art. 14** | **Autonomous Memory Poisoning & Unchecked Promotion**<br>Hallucinated skills polluting agent memory and unvetted production deployments. | **Human-Gated Skill Promotion & Kill Switch:**<br>1. `recordObservedPattern` requires ≥3 occurrences; patterns remain in pending candidate queue until explicit human approval via `/api/skills`.<br>2. Tier-1 profile changes maintain complete rollback history.<br>3. Morning Report ambiguity flags with 1-click `Revert`/`Adjust`.<br>4. `SELF_DEPLOY_ENABLED=false` default kill switch with automated rollback (`kubectl rollout undo`) on probe failure. | [`web-ui/lib/subagents/skillGate.ts`](../web-ui/lib/subagents/skillGate.ts)<br>[`web-ui/lib/memory/profile.ts`](../web-ui/lib/memory/profile.ts)<br>[`web-ui/components/MorningReportView.tsx`](../web-ui/components/MorningReportView.tsx)<br>[`web-ui/lib/deploy/selfDeploy.ts`](../web-ui/lib/deploy/selfDeploy.ts) |
| **NIST GOVERN 1.4**<br>**EU AI Act Art. 12** | **Tamper-Evident Auditability, Lineage & Provenance**<br>Black-box autonomous decisions, untracked code commits, and unverified worker attestation. | **Cryptographic Provenance & OpenTelemetry Waterfalls:**<br>1. SQLite `runs.db` durable ledger tracking `runId`, `parentRunId`, `model`, `prompt`, and verified Git commit SHAs.<br>2. Full `<think>` stream retention across multi-round execution.<br>3. W3C Trace Context distributed tracing across workers and tools.<br>4. Live kernel `/proc/self/status` capability attestation and SLSA-3 container verification. | [`web-ui/lib/ledger/runLedger.ts`](../web-ui/lib/ledger/runLedger.ts)<br>[`web-ui/lib/subagents/llmClient.ts`](../web-ui/lib/subagents/llmClient.ts)<br>[`web-ui/lib/telemetry.ts`](../web-ui/lib/telemetry.ts)<br>[`mcp-server/src/tools/attestation.ts`](../mcp-server/src/tools/attestation.ts) |

---

## 3. Deep-Dive: Deterministic Enforcement Architecture

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │                  Inbound Autonomous Task / User Goal                  │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  LAYER 1: PLANNER & FLYWHEEL RETRIEVAL                                 │
   │  • Historical pattern retrieval from SQLite runs.db                    │
   │  • Deterministic scope-based context scaling (4096 / 8192 tokens)       │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  LAYER 2: BUILDER GENERATION & PRE-WRITE AST GATE                      │
   │  • Code generation via Swift 1.5 Qwen3.8-27B (local GPU)               │
   │  • Pre-write AST compiler validation (TypeScript / Python / SVG)        │
   │  • 3-strike error-signature stuck detection (normalizeErrorSignature) │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  LAYER 3: ADVERSARIAL CRITIC & GROUND-TRUTH OVERRIDE                   │
   │  • Automated test runner executes in isolated container sandbox         │
   │  • Test failure (exitCode != 0) deterministically rejects diff          │
   │  • Independent Critic model reviews diff against acceptance criteria   │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │ Approved
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  LAYER 4: SCOPED GIT COMMITS & OS SUBPROCESS BOUNDARY                   │
   │  • Argv-safe array execution (execFile) with zero shell expansion       │
   │  • Scoped staging: stages ONLY explicit target deliverable              │
   │  • Protected branch gate: refuses commits/pushes to main/develop        │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       │
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  LAYER 5: HUMAN SKILL GATE & DURABLE PROVENANCE                        │
   │  • Patterns observed >= 3 times queued for human sign-off              │
   │  • Cryptographic Git commit SHA recorded in SQLite Run Ledger           │
   │  • Full reasoning traces and OpenTelemetry waterfall persisted         │
   └────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Operational Runbook & Compliance Verification

To verify that the AI Governance controls remain intact across CI and local deployment:

1. **Verify Documentation & Governance Integrity:**
   ```bash
   npx tsx --tsconfig web-ui/tsconfig.json --test web-ui/tests/docsIntegrity.test.ts
   ```
2. **Verify Change-Aware Test Gate & Zero Uncovered Code Rule:**
   ```bash
   npm run test:gate
   ```
3. **Verify Zero-Trust Container Attestation in Live Kubernetes Pod:**
   ```bash
   # Probe live MCP runner zero-trust posture
   kubectl exec -n local-agentic-sandbox deploy/mcp-runner -- node -e "
     const { verifyContainerProvenance } = require('./dist/tools/attestation.js');
     verifyContainerProvenance().then(console.log);
   "
   # Expected output:
   # { execution_uid: "10001:10001 (unprivileged)", root_filesystem: "READ_ONLY", capabilities: "CAP_DROP ALL" }
   ```
