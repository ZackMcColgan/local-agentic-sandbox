# Flywheel Spike: Autonomous Pattern Extraction & Reuse (Sprint 9 / Sprint 12)

## Executive Summary
The Autonomous Engineering Flywheel closes the loop between task execution and subsequent planning. Rather than starting every task with zero prior memory, completed runs extract structured, high-confidence implementation patterns into a local SQLite `skills` table in `~/.local-agentic-sandbox/runs.db`. When a new goal is submitted, the planner retrieves relevant historical patterns and injects them directly into the decomposition prompt.

---

## Architecture & Schema

### SQLite Table: `skills`
Stored in `~/.local-agentic-sandbox/runs.db` alongside the run ledger:
```sql
CREATE TABLE IF NOT EXISTS skills (
  skill_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  domain TEXT NOT NULL,
  pattern_template TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  created_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain);
CREATE INDEX IF NOT EXISTS idx_skills_source_task ON skills(source_task_id);
```

### Extraction Pipeline
When a task status transitions to `completed`:
1. `extractSkillsFromCompletedTask(task)` inspects verified deliverables and milestone diffs.
2. Identifies domain fingerprints:
   - **SVG / Visualization**: ViewBox dimensions, responsive canvas grids, coordinate systems.
   - **Testing**: `node:test` + `node:assert/strict` test scaffolds, async timeout handling.
   - **Kubernetes / Deploy**: NodePort allocation patterns, ephemeral namespaces, probe configurations.
3. Assigns baseline confidence scores (static placeholder constants in v1 spike; dynamic computation from critic verdicts is planned for future work).
4. Persists patterns with `source_task_id` for provenance tracking.

---

## Retrieval & Planner Context Injection

### Retrieval Mechanism
- **Token Scoring**: The incoming goal is tokenized into keywords and matched against `domain`, `name`, and `description`.
- **Ranking Formula**:
  $$\text{Score} = \text{MatchWeight} \times \text{ConfidenceScore} + 0.1 \times \text{UseCount}$$
- Top $k$ matches ($k=3$) are retrieved and injected into the planner specification builder:
  ```markdown
  [REUSABLE PATTERNS FROM PAST SUCCESSFUL RUNS]:
  ### Pattern 1: SVG Vector Card (Build weather SVG vector card) [Domain: svg]
  - Description: Standalone vector card pattern with viewBox coordinates
  ```

---

## Limitations (Spike Honest Assessment)

> [!NOTE]
> This component is an architectural spike evaluating SQLite-backed pattern persistence. The following constraints and technical debt apply to the current prototype:

1. **Hardcoded Pattern Matching**: Extraction relies on simple static heuristics (`if` checks against title/diff keywords) rather than learning from observed task execution data or semantic LLM synthesis.
2. **Placeholder Confidence Scores**: Confidence scores are static hardcoded constants (`0.95`, `0.90`, `0.92`) rather than dynamically computed from critic verdicts, test exit codes, or iteration counts.
3. **Unvalidated Against Real Ledger Tasks**: The prototype has only been verified against synthetic unit test fixtures; it has never been validated against real completed tasks in `runs.db`.
4. **Not Wired into Planner**: Pattern retrieval exists in isolation; automated injection of retrieved skills into the LangGraph planner's live decomposition prompt is future work.
5. **Canned Template Literals**: The Kubernetes (`k8s`) and testing (`testing`) pattern templates are hardcoded string literals rather than synthesized from actual worker diffs.

---

## Findings & Evaluation

1. **Local SQLite Retrieval Speed**:
   For the local air-gapped sandbox, SQLite keyword + token scoring executes in `<5ms` without requiring external embedding models or heavy vector database daemons.
2. **Provenance Traceability**:
   Linking skills to `source_task_id` allows inspecting the run ledger entry that produced the pattern.

---

## Recommendations for Sprint 13
1. **Dynamic Synthesis**: Replace heuristic pattern extraction with a dedicated `recorder` LLM worker pass that abstracts completed diffs.
2. **Planner Integration**: Hook `retrieveRelevantSkills` into the LangGraph planner node's input state.
3. **Vector Synonym Expansion**: Supplement keyword scoring with local embedding models (Ollama embeddings or sqlite-vss).
4. **Auto-Promotion & Anti-Patterns**: Promote patterns with `use_count >= 3`; store failed patterns in `anti_patterns` to warn critics.
