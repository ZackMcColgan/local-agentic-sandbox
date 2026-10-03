# Antigravity Specialized Worker Modelfiles

This directory contains tailored Ollama `Modelfile` definitions for the specialized subagent worker roster.

## Modelfiles

### 1. `Modelfile.builder`
- **Base Model**: `gemma4:e4b`
- **Role**: Sandboxed Builder worker.
- **Tuning**: Low temperature (`0.2`), high context (`8192`), strict code-emission prompt without conversational preambles.
- **Build Command**:
  ```bash
  ollama create antigravity-builder -f deploy/modelfiles/Modelfile.builder
  ```

### 2. `Modelfile.critic`
- **Base Model**: `qwen3.8:27b-q3_k_m`
- **Role**: Adversarial grading and quality critic.
- **Tuning**: Deterministic temperature (`0.1`), structured JSON verdict output (`approved`, `score`, `feedback`), fail-closed abstention rules.
- **Build Command**:
  ```bash
  ollama create antigravity-critic -f deploy/modelfiles/Modelfile.critic
  ```
