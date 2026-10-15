# VRAM Model-Residency Policy

## Hardware Context & Budget
- **GPU**: AMD Radeon RX 9070 XT (16GB VRAM, ROCm on Linux / Windows DirectML/ROCm host)
- **Ollama Host**: Local daemon on `0.0.0.0:11434`
- **Total VRAM**: 16,384 MiB (~16 GB)
- **Context & KV Cache Headroom**: 10% (~1.6 GB)
- **Usable Budget**: ~14.4 GB

---

## Model Roster & Resident Footprints

| Model | Size on Disk / VRAM | Primary Roles | Residency Strategy |
| :--- | :--- | :--- | :--- |
| `qwen3.8:27b-q3_k_m` | ~13.8 GB (fits in 14.4 GB) | General chat, planner | **Primary / Pinned** (`keep_alive: "30m"`) |
| `gemma4:e4b` | ~6.6 GB | Builder, Critic | **Worker / Dynamic** (`keep_alive: "5m"` or `0` on memory pressure) |

---

## Residency Rules

1. **Primary Model Pinning**:
   - `qwen3.8:27b-q3_k_m` is kept resident with `keep_alive: "30m"` for responsive chat interaction and high-context reasoning.
   - When running conversational Q&A or plan generation, Qwen stays in VRAM without repeated cold load delays.

2. **Dynamic Worker Invocation**:
   - When Builder or Critic tasks are scheduled, if `gemma4:e4b` is targeted, Ollama loads Gemma.
   - If total model memory would exceed the 16GB VRAM ceiling, transient models or worker models use `keep_alive: 0` (or `5m` during active multi-turn iteration loops).

3. **Keep-Alive Configuration**:
   - **Pinned / Primary**: `keep_alive: "30m"`
   - **Active Worker Roles (Iteration loops)**: `keep_alive: "5m"`
   - **Task Completion or Memory Pressure**: `keep_alive: 0` (immediate release)

4. **Eviction Order**:
   - When memory pressure occurs, models are unloaded in the following order:
     1. Transient models (`keep_alive: 0`)
     2. Non-roster ad-hoc models
     3. Worker models (Gemma)
     4. Primary pinned model (Qwen, last resort)

5. **Verification**:
   - `ollama ps` monitors resident models and VRAM footprint:
     ```bash
     ollama ps
     ```
   - Automated tests in `web-ui/tests/workerHonesty.test.ts` verify that the residency planner accurately ranks models by role frequency weight, enforces the VRAM budget headroom, and avoids GPU thrash.
