# Model-Residency Policy

## Hardware & Engine Context

- **Inference Engine**: **Strata** (host process, `:8080`, AMD Radeon RX 9070 XT, ROCm/HIP)
- **Primary Model**: **Qwen3.8-Flash-Next (125B-class MoE)**, model id `qwen3.8-flash-next-gyro-gyro-s`
- **Context Window**: 128K tokens (`--max-context 131072` in the live launch config)
- **Fallback Model**: `swift-15-27b-mtp`, served by the optional in-cluster Ollama harness (`llm-rocm-gpu`, `:11434`, scaled to 0 by default)

---

## Model Roster & Residency Strategy

| Model ID                         | Class                               | Primary Roles                                       | Residency Strategy                           |
| :------------------------------- | :---------------------------------- | :-------------------------------------------------- | :------------------------------------------- |
| `qwen3.8-flash-next-gyro-gyro-s` | 125B-class MoE (Qwen3.8-Flash-Next) | General chat, planner, builder, critic, vision      | **Primary / Resident** on host Strata daemon |
| `swift-15-27b-mtp`               | 27B                                 | Fallback when primary is unavailable or constrained | **Fallback** on optional in-cluster Ollama harness (`llm-rocm-gpu`, scaled to 0) |

---

## Residency Rules

1. **Primary Model Residency**:
   - Strata keeps `qwen3.8-flash-next-gyro-gyro-s` resident on the host GPU for all orchestrator, planner, builder, and critic turns at up to 128K context (`--max-context 131072`). The live Strata server serves this single model only.
2. **Fallback**:
   - `swift-15-27b-mtp` is the local fallback model when the primary is unavailable. It is served by the optional in-cluster Ollama harness (`llm-rocm-gpu`, `:11434`), which is scaled to 0 by default and must be scaled up to use the fallback.
3. **Cluster Boundary**:
   - Kubernetes pods (`web-ui`) reach Strata over `strata-service` (`:8080`); no model weights or inference run inside the cluster under the default host-passthrough configuration.
