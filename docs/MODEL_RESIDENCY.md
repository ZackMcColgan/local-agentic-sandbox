# Model-Residency Policy

## Hardware & Engine Context

- **Inference Engine**: **Strata** (host process, `:8080`, AMD Radeon RX 9070 XT, ROCm/HIP)
- **Primary Model**: **Qwen3.8-Flash-Next (125B-class MoE)**, model id `qwen3.8-flash-next-gyro-gyro-s`
- **Context Window**: 128K tokens
- **Fallback Model**: `swift-15-27b-mtp`

---

## Model Roster & Residency Strategy

| Model ID                         | Class                               | Primary Roles                                       | Residency Strategy                           |
| :------------------------------- | :---------------------------------- | :-------------------------------------------------- | :------------------------------------------- |
| `qwen3.8-flash-next-gyro-gyro-s` | 125B-class MoE (Qwen3.8-Flash-Next) | General chat, planner, builder, critic, vision      | **Primary / Resident** on host Strata daemon |
| `swift-15-27b-mtp`               | 27B                                 | Fallback when primary is unavailable or constrained | **Fallback** on host Strata daemon           |

---

## Residency Rules

1. **Primary Model Residency**:
   - Strata keeps `qwen3.8-flash-next-gyro-gyro-s` resident on the host GPU for all orchestrator, planner, builder, and critic turns at up to 128K context.
2. **Fallback**:
   - `swift-15-27b-mtp` serves as the local fallback model if the primary model is unavailable.
3. **Cluster Boundary**:
   - Kubernetes pods (`web-ui`) reach Strata over `strata-service` (`:8080`); no model weights or inference run inside the cluster.
