# Antigravity Specialized Worker Modelfiles

This directory contains tailored Ollama `Modelfile` definitions for the specialized subagent worker roster.

## Modelfiles

### 1. `Modelfile.builder`
- **Base Model**: `swift-15-27b-mtp`
- **Role**: Sandboxed Builder worker.
- **Tuning**: Low temperature (`0.2`), high context (`8192`), strict code-emission prompt without conversational preambles.
- **Build Command**:
  ```bash
  ollama create antigravity-builder -f deploy/modelfiles/Modelfile.builder
  ```

### 2. `Modelfile.critic`
- **Base Model**: `swift-15-27b-mtp`
- **Role**: Adversarial grading and quality critic.
- **Tuning**: Deterministic temperature (`0.1`), structured JSON verdict output (`approved`, `score`, `feedback`), fail-closed abstention rules.
- **Build Command**:
  ```bash
  ollama create antigravity-critic -f deploy/modelfiles/Modelfile.critic
  ```
