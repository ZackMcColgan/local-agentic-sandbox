# ADR-002: LangGraph StateGraph Substrate & Checkpointing for Autonomous Overnight Supervision

**Status**: Accepted  
**Date**: 2026-10-02  
**Author**: Zack McColgan / Autonomous Platform Team  
**Context**: local-agentic-sandbox v2.5 (Mode A: Overnight Builder + Mode B: Local Oracle)

---

## 1. Context & Problem Statement

In Mode A (Overnight Builder), the agent operates autonomously over multi-hour runs without real-time human intervention ("Zack hands it one sentence at night: 'build X'"). 

Traditional autonomous agent loops suffer from catastrophic failure modes:
1. **Unrecoverable Process Termination**: If a worker or supervisor container crashes mid-run (e.g. OOM, uncaught runtime exception, Kubernetes rescheduling at 2 AM), an uncheckpointed loop restarts from step zero, losing hours of build computation and thrashing git history.
2. **Infinite Stall / Retry Loops**: When an agent hits ambiguous requirements or subtle compiler errors, it risks burning GPU cycles and context windows indefinitely without forward progress.
3. **Loss of Auditability**: Hand-rolled loops often fail to provide durable state transitions, making morning review and granular rollbacks arduous.

We required an industry-standard orchestration substrate that provides:
- Per-step and per-milestone state persistence (checkpointing with resumption).
- Deterministic state graph transitions between specialized agents (Planner -> Explorer -> Builder -> Critic -> Recorder).
- Seamless crash recovery and stall detection.
- Portfolio value aligning with current enterprise AI engineering practices.

---

## 2. Decision & Architecture: LangGraph

We evaluated `@langchain/langgraph` alongside a hand-rolled finite state machine (FSM). 

### Decision
We adopted **LangGraph** (`@langchain/langgraph` + `@langchain/core`) as the primary supervisory and execution substrate for the autonomous multi-agent pipeline.

### Architectural Blueprint
```
                 ┌────────────────────────────────────────────────────────┐
                 │                LANGGRAPH STATE GRAPH                   │
                 └────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                                      ┌───────────────┐
                                      │    Planner    │ ───► Emits SPEC.md
                                      └───────┬───────┘
                                              │
                        ┌─────────────────────┴─────────────────────┐
                        ▼                                           ▼
               ┌─────────────────┐                         ┌─────────────────┐
               │    Explorer     │                         │  Supervisor     │
               │ (Read Inventory)│                         │  Watchdog       │
               └────────┬────────┘                         │ (Checkpoints &  │
                        │                                  │  Stall Monitor) │
                        ▼                                  └────────┬────────┘
               ┌─────────────────┐                                  │
               │    Builder      │                                  │
               │ (Toolchain/Run) │                                  │
               └────────┬────────┘                                  │
                        │                                           │
                        ▼                                           │
               ┌─────────────────┐                                  │
               │     Critic      │ ◄────────────────────────────────┘
               │ (Independent AC)│ (Rejection feedback / approval)
               └────────┬────────┘
                        │
                        ▼
               ┌─────────────────┐
               │    Recorder     │ ───► Hermes pattern: skill extraction
               └────────┬────────┘      to .agent/skills/ (iterations >= 2)
                        │
                        ▼
                       END
```

### Key Mechanisms:
1. **State Annotation (`OvernightStateAnnotation`)**:
   - Manages immutable state reductions across turns: `taskId`, `goal`, `status`, `milestones`, `checkpoints`, `ambiguityFlags`, `journal`, `currentDiff`, `currentGitSha`, `nodeHistory`.
2. **Wired Node Implementations**:
   - Every graph node invokes its real domain implementation:
     - `planner`: decomposes natural language goal into machine-checkable `SPEC.md` milestones.
     - `explorer`: executes read-only toolchain inspection via `WorkerPool`.
     - `builder`: executes isolated compilation and generates diffs via `WorkerPool`.
     - `critic`: independently evaluates builder diffs against machine-checkable criteria.
     - `recorder`: evaluates the Hermes skill promotion gate and graduates milestones.
3. **File-Backed LangGraph Checkpointer (`FileCheckpointSaver`)**:
   - Extends LangGraph's `MemorySaver` / `BaseCheckpointSaver`.
   - On every step execution, LangGraph checkpoints state and serializes thread storage to `${taskId}-lg-checkpoint.json` on disk.
   - On container restart or supervisor crash, LangGraph rehydrates from the checkpoint file and resumes execution directly from the next scheduled node (`app.stream(null, { configurable: { thread_id } })`), never restarting from step zero.
4. **Critic Separation of Concerns**:
   - The Builder is prohibited from grading its own work. The Critic independently validates generated diffs against machine-checkable acceptance criteria defined in `SPEC.md`. Discrepancies are rejected back to the Builder.
5. **Hermes Skill Promotion Gate**:
   - Solves taking $\ge 2$ iterations or flagged non-trivial are extracted by the Recorder subagent into `.agent/skills/` as durable knowledge for future runs.
6. **Autonomy Policy & Stall Detection**:
   - If no forward progress occurs for 20 minutes (configurable), the supervisor snapshots state, attempts one recovery re-plan, then parks the task and generates an `AmbiguityFlag`. The overnight builder never blocks on ambiguity or spins indefinitely.

---

## 3. Consequences & Verification

### Positive:
- **Resilience**: Verified by automated test suites (`tests/supervisor.test.ts`):
  - Worker crash mid-milestone $\rightarrow$ supervisor reloads checkpoint and resumes.
  - Supervisor process kill $\rightarrow$ new supervisor instance resumes from step 2 without losing milestone 1.
- **Auditability**: Morning report generation (`tests/morningReport.test.ts`) renders every judgment call with one-tap revert actions.
- **Portability**: Standardizes state graph topology using LangGraph primitives recognized in enterprise AI engineering.

### Negative / Trade-Offs:
- Requires bundling `@langchain/langgraph` and `@langchain/core` dependencies (~1.5 MB).
- Additional serialization overhead per milestone (negligible in multi-minute overnight runs).
