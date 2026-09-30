# local-agentic-sandbox

A full-stack, zero-trust autonomous AI coding platform. Orchestrates local LLMs via Ollama, Model Context Protocol (MCP), and hardened container sandboxes for safe autonomous code execution and web documentation retrieval.

---

## Architecture Overview

```
                      INTERNET
                         │
                         ▼ (egress-mesh)
               ┌───────────────────┐
               │      web-ui       │ ◄── Next.js 15 Web Portal & Multi-MCP Orchestrator
               └─────────┬─────────┘
                         │
  ═══════════════════════╪═══════════════════════════════════════════════════
                         ├─────────────────────────────┐
                         ▼ (egress-mesh)               ▼ (ai-mesh: zero egress)
        ┌──────────────────────────────────┐  ┌──────────────────────────────┐
        │        browser-mcp (8081)        │  │       mcp-server (8080)      │
        │ • Web search (DuckDuckGo)        │  │ • Python Code & Pytest Runner│
        │ • SSRF Protection Guard          │  │ • read_only rootfs           │
        │ • HTML-to-Markdown Scraper       │  │ • cap_drop: ALL              │
        │ • user: 10002:10002              │  │ • user: 10001:10001          │
        └──────────────────────────────────┘  └──────────────┬───────────────┘
                                                             │ (ai-mesh)
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │      ollama (Air-Gapped)     │
                                              │ • Qwen 3.8 27B Q3_K_M        │
                                              │ • GPU Accelerated            │
                                              └──────────────────────────────┘
```

* **Local AI Inference Engine**: Self-hosted `qwen3.8:27b-q3_k_m` (~13.8 GB VRAM footprint) running 100% on GPU with ~2.2 GB headroom on 16 GB GPUs (e.g. AMD Radeon RX 9070 XT).
* **Hardened Execution Boundary (`mcp-server`)**: Completely air-gapped on `ai-mesh` (`internal: true`). Non-root (`uid: 10001`), `read_only: true` rootfs, `cap_drop: ALL`, and ephemeral `tmpfs` execution buffer.
* **Isolated Browser Boundary (`browser-mcp`)**: Separate egress-enabled scraper on port 8081 (`uid: 10002`) with built-in SSRF protection to securely fetch documentation without exposing the code runner or host network.
* **Web Portal & Orchestrator (`web-ui`)**: Next.js 15 streaming interface with dynamic model routing, reasoning effort controls, and visual execution traces.

---

## Security Boundary Matrix

| Container | Network | Filesystem | Linux Capabilities | User ID | Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`mcp-server`** | `ai-mesh` (zero egress) | `read_only: true` | `cap_drop: ALL` | `10001:10001` | Air-Gapped Code Execution |
| **`browser-mcp`** | `ai-mesh`, `egress-mesh` | Read-Only App | Default (No Privs) | `10002:10002` | Isolated Web Documentation Scraper |
| **`ollama`** | `ai-mesh` (zero egress) | Volume Mounted | Default | Root (in-container) | Air-Gapped LLM Inference |
| **`web-ui`** | `ai-mesh`, `egress-mesh` | Read-Write | Default | Non-Root | Web Client & Multi-MCP Dispatcher |

---

## Quickstart

You can manage the sandbox using either `make` or `npm`:

### 1. Ingest Model Weights
```bash
# Pull primary orchestrator model (qwen3.8:27b-q3_k_m)
make pull-primary
# OR: npm run pull:primary
```

### 2. Launch the Platform
```bash
make up
# OR: npm run up
```

### 3. Run Automated Tests & Code Coverage
```bash
make test
# OR: npm test
```

### 4. Verify Security Hardening
```bash
make verify-sec
```

Once running, access the web interface at **`http://localhost:3000`**.

---

## Related Documentation

* [ARCHITECTURE.md](./ARCHITECTURE.md) - In-depth zero-trust topology and threat modeling.
* [DEVELOPMENT_SANDBOX.md](./docs/DEVELOPMENT_SANDBOX.md) - Guide for running inside isolated microVMs and development sandboxes.
* [ADR-001: Sandboxed MCP Architecture](./docs/ADR-001-sandboxed-mcp.md) - Architectural Decision Record for containerized MCP.
