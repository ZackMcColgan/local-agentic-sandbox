# Agentic Sandbox Memory & Model Registry

## Active Primary Model
- **Active model**: `swift-15-27b-mtp` (Swift 1.5, Qwen3.8 27B base)
- **Quantization**: `Q3_K_M` (~13.4 GB)
- **MTP**: enabled (`draft_num_predict 3`)
- **Context**: 4096 default, 8192 project scope, 16384 overnight
- **KV Cache**: `q4_0`
- **Previous model**: `swift-27b-mtp` (retired Oct 14)
- **Thinking / Reasoning**: Generates native reasoning terminated with `</think>` tags, separated cleanly from deliverables.
- **Hardware Profile**: 16 GB VRAM budget (AMD Radeon RX 9070 XT), CPU-pinned embedding (`all-minilm` with `num_gpu: 0`).
