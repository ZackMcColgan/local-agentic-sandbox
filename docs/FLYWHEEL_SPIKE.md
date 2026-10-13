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
3. Computes confidence score based on critic verdicts (`criticScore >= 85` -> `confidenceScore >= 0.9`).
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

## Findings & Evaluation

1. **Deterministic Accuracy**:
   Extracting verified diff additions ensures that only code that actually passed critic review and unit tests becomes a pattern.
2. **Zero Hallucination**:
   Because patterns come with explicit `source_task_id` links, they provide grounded few-shot examples for local models (e.g. `swift-27b-mtp`).
3. **Keyword vs. Vector Search**:
   For the local air-gapped sandbox, SQLite keyword + token scoring operates in `<5ms` without requiring external embedding models or heavy vector database daemons. For Sprint 13, embedding vector search (via Ollama embeddings or sqlite-vss) can supplement keyword search for semantic synonym expansion.

---

## Recommendations for Sprint 13
1. **Auto-Promotion**: Automatically promote patterns with `use_count >= 3` into the system instructions for builder workers.
2. **Negative Pattern Filtering**: Store failed / rejected patterns in an `anti_patterns` table so critic workers can warn against repeating known flaws.
