# Architecture Specification: local-agentic-sandbox

**Repository**: `local-agentic-sandbox`  
**Description**: Full-stack, zero-trust autonomous AI coding platform. Orchestrates local LLMs via Ollama, Model Context Protocol (MCP), and hardened container sandboxes for autonomous code generation, execution, testing, and documentation retrieval.

---

## 1. Executive Summary & Problem Statement

### The Problem
Autonomous AI coding agents need to generate, test, and debug code in real time. Running agent-generated scripts directly on developer workstations or production hosts poses severe security risks: arbitrary execution, credential theft, and network exfiltration.

### The Solution
`local-agentic-sandbox` implements a **zero-trust, multi-boundary containerized architecture**:
1. **Local AI Inference Engine**: Self-hosted LLMs (`qwen3.8:27b-q3_k_m` and `gemma4:e4b`) served via Ollama directly over host GPU hardware (AMD Radeon RX 9070 XT 16GB VRAM, ROCm), fully air-gapped from internet egress with 24-hour VRAM keep-alive leases.
2. **Hardened Execution Boundary (`mcp-server` / `mcp-runner`)**: An unprivileged, read-only container executing 8 autonomous developer tools over Model Context Protocol (MCP) via Server-Sent Events (SSE), strictly sandboxed (`read_only` rootfs, `cap_drop: ALL`, `uid: 10001`, `tmpfs: /tmp (noexec)`).
3. **Isolated Browser Boundary (`browser-mcp`)**: An isolated egress-enabled web scraper and search proxy with built-in SSRF protection blocking RFC 1918 subnets, fetching external documentation safely.
4. **Web UI & Autonomous Agent Orchestrator (`web-ui`)**: A Next.js 15 interface featuring a real-time conversational chat, segmented tri-mode model dispatcher (`[ ✨ Auto | ⚡ Flash | 🧠 Pro ]`), multimodal vision ingestion pipeline, OpenTelemetry distributed tracing waterfall, and persistent session storage.
5. **Observability Engine (`otel-collector` / Jaeger)**: Real-time distributed trace collection across agent turns, tool dispatches, and command executions.

---

## 2. System Architecture & Topology

[![local-agentic-sandbox Architecture](./docs/architecture.drawio.svg)](./docs/architecture.drawio.svg)
*Figure 2.1: Full-stack zero-trust architecture across Kubernetes namespace `local-agentic-sandbox`, air-gapped MCP execution boundary, isolated browser scraper, and host GPU inference. Edit source: [docs/architecture.drawio](./docs/architecture.drawio).*

### 2.1 Component Architecture Diagram

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                CLIENT & INGRESS LAYER                                             │
│                                                                                                   │
│     Mobile / Tablet              Desktop Browser                LAN Reverse Proxy Bridge          │
│    (192.168.50.254:80)         (localhost:3000/3001)             (scripts/lan-bridge.js)          │
│            │                             │                        Binds 0.0.0.0:80 / :3000        │
│            └─────────────────────────────┼───────────────────────────────────┘                    │
└──────────────────────────────────────────┼────────────────────────────────────────────────────────┘
                                           │
┌──────────────────────────────────────────┼────────────────────────────────────────────────────────┐
│  KUBERNETES CLUSTER (Docker Desktop)     │ Namespace: local-agentic-sandbox                       │
│                                          ▼                                                        │
│   ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │   Web UI & Agent Orchestrator (Deployment / Service: web-ui:3000 / NodePort 30300)        │   │
│   │   - Next.js 15 / React 19 / TypeScript / Tailwind CSS                                     │   │
│   │   - Tri-Mode Model Dispatcher: [ ✨ Auto | ⚡ Flash | 🧠 Pro ]                             │   │
│   │   - Multimodal Vision Ingestion Pipeline (visionProcessor.ts -> gemma4:e4b)              │   │
│   │   - Session Chat Persistence (localStorage: local_agent_chat_history_v1)                 │   │
│   │   - OpenTelemetry Instrumentation SDK (telemetry.ts -> Jaeger trace waterfall)           │   │
│   │   - Zero-Cold-Start VRAM Leases (keep_alive: "24h" on all Ollama dispatches)              │   │
│   └──────────────────────┬────────────────────────────────────┬───────────────────────────────┘   │
│                          │                                    │                                   │
│           NetworkPolicy: egress-mesh                          │   NetworkPolicy: ai-mesh          │
│           (Allow HTTP/HTTPS Egress Only)                      │   (Deny All Internet Egress)      │
│                          │                                    │                                   │
│                          ▼                                    ▼                                   │
│   ┌──────────────────────────────────────────────┐     ┌──────────────────────────────────────┐   │
│   │ Browser MCP Service (browser-mcp:8081)       │     │ MCP Runner Service (mcp-runner:8080) │   │
│   │ - Isolated Web Scraper & DuckDuckGo Search   │     │ - 8 Autonomous Developer Tools       │   │
│   │ - Built-in SSRF Guard (blocks RFC 1918)      │     │ - Argv-Safe Git Execution (No Shell) │   │
│   │ - HTML-to-Clean-Markdown Processor           │     │ - ReDoS-Guarded Regex Search         │   │
│   │ - user: 10002:10002 | read-only app          │     │ - user: 10001:10001 | cap_drop: ALL  │   │
│   └──────────────────────┬───────────────────────┘     │ - read_only rootfs | tmpfs /tmp      │   │
│                          │                             └──────────────────┬───────────────────┘   │
│                          ▼                                                │                       │
│                   Public Internet                                         ▼                       │
│              (Docs, GitHub, Web Pages)                       ┌───────────────────────────────┐    │
│                                                              │ Workspace Persistent Volume   │    │
│                                                              │ (./workspace:/workspace:rw)   │    │
│                                                              │ - Git Repo & Feature Branches │    │
│                                                              │ - .agent/skills/ Hermes Loop  │    │
│                                                              └───────────────────────────────┘    │
│   ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Distributed Tracing Engine (Deployment: otel-collector:4318, 4317, 16686)                │   │
│   │ - Jaeger UI & Trace Waterfall Analytics for user turns & tool executions                  │   │
│   └───────────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────┬────────────────────────────────────────────────────────┘
                                           │ (ExternalName / host.docker.internal:11434)
┌──────────────────────────────────────────▼────────────────────────────────────────────────────────┐
│  HOST INFERENCE BOUNDARY (AMD Radeon RX 9070 XT 16GB VRAM / ROCm)                                 │
│                                                                                                   │
│   Ollama Service (Host: 0.0.0.0:11434)                                                            │
│   ├── qwen3.8:27b-q3_k_m (13.3 GB VRAM) ── Primary Orchestrator & Autonomous Coding Engine        │
│   └── gemma4:e4b         (3.4 GB VRAM)  ── Fast Multimodal Diagram Ingestion & Triage (~80 tok/s) │
│                                                                                                   │
│   * Active 24h VRAM Keep-Alive Lease ensures zero-cold-start latency on conversational turns.     │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Network & Security Isolation Matrix

| Component / Pod | Placement | Filesystem Mode | Linux Capabilities | User ID | Role & Network Isolation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`mcp-runner`** | `local-agentic-sandbox` | **`read_only: true`** | **`cap_drop: ALL`** | **`10001:10001`** | Air-Gapped Code Execution. NetworkPolicy: Deny-all egress except CoreDNS (`:53`) and GitHub HTTPS (`:443`). |
| **`browser-mcp`** | `local-agentic-sandbox` | Read-Only App | Default (No Privs) | **`10002:10002`** | Isolated Web Scraper & DuckDuckGo Search. Built-in SSRF guard blocking RFC 1918 private subnets. NetworkPolicy: HTTP/HTTPS outbound egress only. |
| **`web-ui`** | `local-agentic-sandbox` | Read-Write | Default | Non-Root | Next.js 15 Web Portal & Multi-MCP Dispatcher (Port 3000 / NodePort 30300). NetworkPolicy: Egress allowed to internal MCP services, Jaeger, and host Ollama. |
| **`otel-collector`**| `local-agentic-sandbox` | Ephemeral | Default (No Privs) | Non-Root | Distributed Jaeger Tracing Engine (Ports 4318, 4317, 16686). |
| **`ollama`** | Host Passthrough / PCIe | Local Drive | Host Native | Host User | Air-Gapped GPU Inference (AMD Radeon RX 9070 XT 16GB VRAM, ROCm, Port 11434). Accessible to cluster via `ExternalName: host.docker.internal`. |

### 3.1 Host-Filesystem Write Trust Boundary (`./workspace:/workspace:rw`)

The MCP toolchain container mounts the host directory `./workspace` into `/workspace` with read-write access (`:rw`):
* **Design Rationale**: This direct bind mount enables seamless local pair programming. Code files, git feature branches, test suites, architecture diagrams (`.drawio.svg`), and learned agent skills (`.agent/skills/`) generated by the model are written directly to the host filesystem so the developer can review, inspect, and run them locally without manual exports.
* **Trust Implications & Blast Radius**:
  * Any tool execution by the autonomous agent (`workspace_write_file`, `workspace_run_command`) operates directly on files inside `./workspace` with the permissions of the host process running Docker.
  * While path traversal outside `/workspace` is strictly rejected by `resolveSafePath()` and container root is read-only, **any file within `./workspace` can be modified or overwritten** by the agent or by commands executed via `workspace_run_command`.
  * **Operational Hardening**:
    1. Never symlink sensitive host directories (such as `~/.ssh`, `~/.aws`, `~/.kube`, or system credentials) into `./workspace`.
    2. Treat `./workspace` as an untrusted code sandbox that is monitored via version control. Git initializes an automatic repository with commit history inside `./workspace` to allow tracking and reverting agent modifications.

### 3.2 LAN Reverse Proxy Bridge Security Tradeoff

The LAN reverse proxy bridge (`scripts/lan-bridge.js`) binds to `0.0.0.0` on ports `80` and `3000` without authentication:
* **Owner Decision**: Unrestricted access across the local home area network allows seamless pairing from mobile phones and tablets (e.g. `http://192.168.50.254/`) via simple browser bookmarks without authentication friction.
* **Blast Radius**: Any device on the home LAN (guests, personal phones, IoT devices) can access the Web UI and drive `workspace_run_command`. Execution is strictly restricted to the containerized `/workspace` sandbox under UID `10001` with no host-level privileges.
* **Startup Warning**: On launch, the bridge emits an explicit security notice in console logs referencing the documentation.
* **Opt-In Hardening**: If token protection is required in the future, the bridge supports an optional `BRIDGE_AUTH_TOKEN` environment variable with bookmark query parameter (`?token=...`) auto-hydration into secure cookies.

---

## 4. Repository Structure

```text
local-agentic-sandbox/
├── README.md                           # Project overview, quickstart & security matrix
├── ARCHITECTURE.md                     # System architecture specification & threat model
├── package.json                        # Root npm workspace configuration & test scripts
├── docker-compose.yml                  # Docker Compose multi-container deployment
├── Makefile                            # Make orchestration targets (up, down, test, pull)
├── deploy/
│   ├── helm/
│   │   └── local-agentic-sandbox/      # Helm chart for Kubernetes deployment
│   │       ├── Chart.yaml
│   │       ├── values.yaml             # Configurable values (GitHub CIDRs, replicas, ports)
│   │       └── templates/              # Kubernetes templates (deployments, services, network policies)
│   └── k8s/
│       ├── kustomization.yaml          # Kustomize manifest for Docker Desktop Kubernetes
│       ├── namespace.yaml              # Namespace definition: local-agentic-sandbox
│       ├── web-ui.yaml                 # Next.js UI deployment & NodePort service
│       ├── mcp-runner.yaml             # Air-gapped code runner deployment & service
│       ├── browser-mcp.yaml            # SSRF-guarded browser scraper deployment & service
│       ├── ollama-service.yaml         # ExternalName service pointing to host.docker.internal
│       ├── observability.yaml          # Jaeger OpenTelemetry collector deployment & service
│       ├── network-policies.yaml       # Zero-trust network egress & ingress policies
│       └── workspace-pvc.yaml          # HostPath persistent volume claim for ./workspace
├── docs/
│   ├── architecture.drawio             # Editable Draw.io XML source diagram
│   ├── architecture.drawio.svg         # Rendered vector SVG diagram for README/docs
│   ├── ADR-001-sandboxed-mcp.md        # Architectural Decision Record for containerized MCP
│   ├── ANTIGRAVITY_AUTONOMOUS_SPEC.md  # Autonomous pair-programming agent specification
│   └── DEVELOPMENT_SANDBOX.md          # Guide for microVM development sandboxes
├── scripts/
│   ├── lan-bridge.js                   # Zero-auth LAN reverse proxy bridge (0.0.0.0:80 / :3000)
│   └── test-ui-render.js               # Headless visual inspection test script
├── browser-mcp/
│   ├── Dockerfile
│   ├── package.json
│   └── src/                            # SSRF protection, DuckDuckGo search, HTML cleaning
├── mcp-server/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                    # SSE transport & tool registry
│   │   └── tools/
│   │       ├── codeRunner.ts           # Sandboxed Python execution & kernel attestation
│   │       ├── attestation.ts          # Docker Scout & runtime boundary verification
│   │       └── workspaceTools.ts       # 8 argv-safe git & filesystem tools (ReDoS guarded)
│   └── tests/                          # 25 unit & security integration tests
├── web-ui/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                    # Main portal: tabs, persistent state, live telemetry
│   │   └── api/
│   │       ├── chat/route.ts           # Tri-mode LLM dispatcher & 24h keep-alive lease
│   │       └── sandbox-status/route.ts # Live container security health probe
│   ├── components/
│   │   ├── ChatStream.tsx              # Interactive conversational chat interface
│   │   ├── ModelSelector.tsx           # Segmented [ Auto | Flash | Pro ] control
│   │   ├── ExecutionTrace.tsx          # Real-time tool execution & agent steps
│   │   ├── TraceWaterfall.tsx          # OpenTelemetry Jaeger distributed trace visualizer
│   │   ├── SandboxGauge.tsx            # Visual security boundary posture indicator
│   │   ├── DiffViewer.tsx              # Side-by-side git diff viewer
│   │   └── Navbar.tsx                  # Responsive navigation header
│   ├── lib/
│   │   ├── agentEngine.ts              # Autonomous test-and-repair agent execution loop
│   │   ├── chatHistory.ts              # Versioned localStorage persistence (v1)
│   │   ├── fileParser.ts               # File ingestion & multimodal base64 extractor
│   │   ├── modelDispatcher.ts          # Tri-mode complexity classifier & model router
│   │   ├── telemetry.ts                # OpenTelemetry SDK span generation & Jaeger export
│   │   ├── toolParser.ts               # XML/JSON tool call extractor & tag cleaner
│   │   └── visionProcessor.ts          # Multimodal diagram ingestion pipeline
│   └── tests/                          # 32 unit & component tests
└── workspace/                          # Sandboxed host directory mounted to /workspace:rw
```

---

## 5. Development with Docker Sandboxes & Google Antigravity

To safely run Google Antigravity CLI (`agy`) inside a secure microVM environment with its own Docker daemon, use Oleg Šelajev's kit:

```bash
# Run Antigravity inside Docker Sandbox
sbx run --kit git+https://github.com/shelajev/agy-sbx-kit.git agy .
```

---

## 6. Verification & Quickstart

### 6.1 Kubernetes Deployment (Docker Desktop / Production)

All platform workloads reside inside the dedicated `local-agentic-sandbox` namespace:

```bash
# 1. Deploy via Kustomize
kubectl apply -k deploy/k8s

# OR: Deploy via Helm
helm install local-agentic-sandbox deploy/helm/local-agentic-sandbox -n local-agentic-sandbox --create-namespace

# 2. Verify all pods and services in the local-agentic-sandbox namespace
kubectl get all -n local-agentic-sandbox

# 3. Access Web UI (NodePort 30300 or port-forward to 3001)
kubectl port-forward svc/web-ui -n local-agentic-sandbox 3001:3000 --address 0.0.0.0
```

> **Note**: Docker Desktop's GUI dashboard filters by the `default` namespace by default. Always specify `-n local-agentic-sandbox` when inspecting cluster workloads via CLI or select the `local-agentic-sandbox` namespace dropdown in Docker Desktop.

### 6.2 Docker Compose Quickstart

```bash
# 1. Pull the primary orchestrator model into host Ollama
make pull-primary
# OR: npm run pull:primary

# 2. Build and launch all services
make up
# OR: npm run up

# 3. Run all test suites across workspaces (57 tests)
npm test

# 4. Verify security isolation boundaries
make verify-sec
```
