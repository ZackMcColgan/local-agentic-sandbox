# local-agentic-sandbox

Overnight autonomous AI coding system for local hardware. Hand it an engineering task or goal, go to sleep, and wake up to a verifiable git trail, completed deliverables, and a comprehensive morning report. Designed to run entirely on local, air-gapped consumer hardware with zero cloud API limits, zero per-token inference charges, and complete data privacy.

---

## What It Is

`local-agentic-sandbox` is an autonomous software engineering appliance. It orchestrates local LLM inference via Ollama, Model Context Protocol (MCP) tool servers, and hardened execution sandboxes to plan, implement, review, and verify multi-milestone code tasks autonomously.

- **Overnight Autonomy**: Dispatches tasks to a multi-subagent supervisor loop that works through milestones independently.
- **Verifiable Git Trail**: Every completed milestone produces real git commits with scoped diffs, explicit target files, and commit hashes.
- **Fail-Closed Resilience**: Strict contract assertions, automated test gates, and durable checkpointing ensure flawed code is rejected rather than committed.
- **Zero Cloud Dependencies**: Powered locally by `swift-27b-mtp` via Ollama with active VRAM lease management (`keep_alive: "24h"`).

---

## The Autonomy Loop

The core architecture follows an iterative, fail-closed supervisor pipeline:

```
                  ┌───────────────────────────────┐
                  │            PLANNER            │
                  │  (Decomposes goal into SPEC)  │
                  └──────────────┬────────────────┘
                                 │
                                 ▼
                    ┌───────────────────────────┐
       ┌───────────►│          BUILDER          │
       │            │  (Implements code diffs)  │
       │            └────────────┬──────────────┘
       │                         │
  needs_fix                      ▼
(max 5 retries)     ┌───────────────────────────┐
       │            │          CRITIC           │
       └────────────┤ (Adversarial verification)│
                    └────────────┬──────────────┘
                                 │ approved
                                 ▼
                    ┌───────────────────────────┐
                    │         RECORDER          │
                    │ (Promotes reusable skills)│
                    └────────────┬──────────────┘
                                 │
                                 ▼
                    ┌───────────────────────────┐
                    │      GIT COMMIT &         │
                    │   DURABLE CHECKPOINT      │
                    └───────────────────────────┘
```

1. **Planner**: Analyzes the user's task prompt or goal and decomposes it into an ordered list of concrete, verifiable milestones (`M1`, `M2`, ...) with machine-checkable acceptance criteria and target deliverable contracts.
2. **Builder ⇄ Critic Loop**:
   - **Builder**: Writes targeted code diffs for the active milestone, adhering strictly to scoped file boundaries and compiler AST validation.
   - **Critic**: An adversarial review agent that evaluates builder diffs against ground-truth test suite exit codes and acceptance criteria. It operates on a **fail-closed design**: if tests fail, if no diff is produced, or if evidence is missing, the critic rejects the iteration with actionable feedback or abstains. Never self-grades or approves broken code.
3. **Recorder**: Identifies patterns in complex, multi-iteration fixes and promotes them into modular skills for future tasks.
4. **Checkpointing & Crash Recovery**: At every milestone transition, the supervisor persists durable checkpoints to disk (`chk-*`). If a worker container crashes or the host process receives `SIGKILL`, the supervisor restarts from the last valid checkpoint and resumes forward progress without corrupting git state.

---

## Architecture & Security Boundary

| Pod / Container | Namespace | Security Context | Network Policy | Role |
| :--- | :--- | :--- | :--- | :--- |
| **`mcp-runner`** | `local-agentic-sandbox` | `read_only: true`, `cap_drop: ALL`, UID `10001` | Deny-All Egress (Air-Gapped) | Sandboxed filesystem operations, command execution, and test runs in `/workspace`. |
| **`browser-mcp`** | `local-agentic-sandbox` | Read-only rootfs, unprivileged UID `10002` | Egress-Mesh Only | Isolated web scraper for documentation retrieval and DuckDuckGo searches (`search_web`). Blocks RFC 1918 private subnets. |
| **`web-ui`** | `local-agentic-sandbox` | Non-root, Next.js 15 | Cluster Internal | Interactive portal, chat streaming, thread management, and LiveRunBlock supervisor dashboard. |
| **`ollama`** | Host Passthrough | Native GPU / ROCm | Host Only (Port 11434) | GPU inference engine hosting `swift-27b-mtp`. |

> **LAN Appliance Security Notice**: API routes have no auth — this is a LAN appliance design decision, not an oversight. The sandbox is built as a single-tenant appliance within an isolated local network, deliberately eliminating authentication overhead. Do not expose these ports directly to the public internet without a secure reverse proxy.

---

## Running the Platform

### Primary Deployment: Kubernetes (Docker Desktop / Production)

Kubernetes is the primary, production-grade deployment mode:

```bash
# Deploy all services to local-agentic-sandbox namespace
make k8s-deploy

# Verify pod status and health
kubectl get pods -n local-agentic-sandbox
```

Once deployed, access the Web UI at http://localhost:3000 (or NodePort `30300`).

### Legacy Deployment: Docker Compose

Docker Compose is maintained for legacy local testing:

```bash
# Launch via Docker Compose
make up
# Or directly:
docker compose up -d
```

### Running Test Verification

The repository enforces a change-aware test gate (<90s budget) ensuring zero regression:

```bash
# Run the test suite via npm
npm test

# Run the strict change-aware test gate
npm run test:gate
```

---

## Sample Morning Report

When an overnight task completes, a structured morning report is generated summarizing milestones, git commits, test verification tiers, and any ambiguity flags flagged for human review:

```markdown
# Autonomous Morning Report: task-1728284400-w3ath

✅ **Status: COMPLETED** | Branch: `feat/v2.5-overnight` | Duration: 42m 15s
Git HEAD: `7a9b1c2` | Started: 2026-10-06T23:00:00.000Z | Finished: 2026-10-06T23:42:15.000Z

### Goal
> Create a standalone SVG weather visualization component with dynamic sun and cloud glyphs

---

## 1. Milestones & Test Verification

| Milestone | Status | Commit SHA | Tests Passed | Tests Failed | Diff Summary |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **M1: Scaffold SVG canvas** | completed | `3d4e5f6` | 8 passed | 0 failed | + web-ui/components/WeatherSvg.tsx |
| **M2: Implement weather glyphs** | completed | `5a6b7c8` | 14 passed | 0 failed | + web-ui/lib/weatherGlyphs.ts |
| **M3: Add forecast metadata styling** | completed | `7a9b1c2` | 22 passed | 0 failed | + web-ui/tests/weatherSvg.test.ts |

**Total Test Suite Result**: **44 passed**, **0 failed**.

---

## 2. Test Verification Tiers (Phase C)

| Tier | Command | Status | Duration | Budget | Tests Passed | Tests Failed | Details |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Change Gate** | `npm run test:gate` | ✅ Passed | 14.2s | <90s | 44 | 0 | All affected unit & contract suites clean |
| **Tier 2: Full Suite** | `npm test` | ✅ Passed | 38.6s | — | 182 | 0 | Full regression suite clean |

---

## 3. Ambiguity Flags & Judgment Calls (0)

No ambiguities encountered. Execution adhered strictly to the specification and deliverable contracts.
```
