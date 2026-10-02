# local-agentic-sandbox

A full-stack, zero-trust autonomous AI coding platform. Orchestrates local LLMs via Ollama, Model Context Protocol (MCP), and hardened container sandboxes for safe autonomous code execution and web documentation retrieval.

---

## Architecture Overview

<p align="center">
  <img src="docs/architecture.drawio.svg" alt="local-agentic-sandbox v2.5 Architecture Diagram" width="100%" />
</p>
<p align="center">
  <em>Figure 1: Full-stack zero-trust architecture, LangGraph supervisor, two-tier sandbox (build vs. exec), and air-gapped inference. Editable source: <a href="docs/architecture.drawio">docs/architecture.drawio</a>.</em>
</p>

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

---

## LAN Bridge Security

The LAN reverse proxy bridge (`scripts/lan-bridge.js`) binds to `0.0.0.0` on ports `80` and `3000` without authentication. This is an **intentional design decision** by the system owner to allow seamless, frictionless access from mobile devices, tablets, and laptops across the private home local area network (e.g. `http://192.168.50.254/`) via simple browser bookmarks without token prompts.

### Blast Radius & Threat Model
* **Scope**: The bridge is not exposed to the public internet; exposure is strictly bounded to the local home network (e.g., family devices, guest Wi-Fi devices, or compromised IoT hardware on the same subnet).
* **Execution Capabilities**: Any unauthenticated client on the home LAN that connects to the Web UI can prompt the autonomous agent to invoke `workspace_run_command`, which executes arbitrary shell commands inside the sandboxed container workspace (`/workspace`).
* **Container Defenses**: Even with unauthenticated LAN access, execution is contained within an unprivileged UID (`10001`), root filesystem is mounted `read_only`, Linux capabilities are dropped (`cap_drop: ALL`), and egress network access from the code runner is blocked via network policies.

### Optional Hardening Path (Opt-In)
If authenticated access is ever desired in the future, the bridge can be hardened without breaking mobile usability:
1. **Environment-Driven Bearer Token**: Introduce an optional `BRIDGE_AUTH_TOKEN` environment variable.
2. **Bookmark Query Token**: Allow mobile bookmarks to authenticate seamlessly via URL query parameter (`http://192.168.50.254/?token=<SECRET_TOKEN>`), which the bridge extracts and converts into an HTTP-only session cookie.
3. **LAN Header Validation**: Reject any inbound LAN requests lacking the valid bearer token or session cookie with HTTP `401 Unauthorized`.

---

## Host-Filesystem Write Trust Boundary (`./workspace:rw`)

The `mcp-server` execution boundary mounts `./workspace` from the host directly into `/workspace:rw`:
* **Intentional Pair Programming Design**: Code written by the autonomous agent, git branches, test suites, diagrams, and learned skills are saved directly to `./workspace` on the host machine.
* **Blast Radius**: While the container root filesystem is `read_only` and path traversal outside `/workspace` is strictly rejected, any file placed inside `./workspace` can be read, written, or modified by the agent via `workspace_write_file` and `workspace_run_command`.
* **Security Guidance**:
  * Never create symlinks inside `./workspace` that point to sensitive host directories (such as `~/.ssh`, cloud credentials, or parent repositories).
  * Treat `./workspace` as an untrusted code sandbox that is monitored via version control. Git initializes an automatic repository with commit history inside `/workspace` to allow tracking and reverting agent-generated changes.


