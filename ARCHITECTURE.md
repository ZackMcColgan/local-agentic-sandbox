# Architecture Specification: local-agentic-sandbox

**Repository**: `local-agentic-sandbox`  
**Description**: Full-stack, air-gapped agentic AI platform. Orchestrates local LLMs via Ollama, Model Context Protocol (MCP), and hardened container sandboxes for autonomous code generation, execution, and verification.

---

## 1. Executive Summary & Problem Statement

### The Problem
Enterprises and developers want autonomous coding agents that can generate, test, and debug code in real time. However, running agent-generated scripts directly on developer workstations or production hosts poses severe security risks: arbitrary execution, credential theft, and network exfiltration.

### The Solution
`local-agentic-sandbox` implements a **zero-trust, decoupled three-tier containerized topology**:
1. **Local AI Inference Engine**: Self-hosted LLM (Qwen / Gemma) via Ollama, completely air-gapped.
2. **Hardened Execution Boundary (MCP Server)**: An unprivileged, read-only container executing tools over Model Context Protocol (MCP) via Server-Sent Events (SSE).
3. **Web UI & Agent Orchestrator**: A responsive Next.js 15 interface featuring a real-time conversational chat, visual agent execution trace, and a live sandbox governance inspector.

---

## 2. System Architecture & Topology

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              HOST MACHINE (DOCKER ENGINE)                              │
│                                                                                        │
│   ┌──────────────────────┐      ┌──────────────────────────────────┐                   │
│   │   Browser Client     │ ───► │   Web UI & Agent Orchestrator    │                   │
│   │   (Port 3000)        │      │   - Next.js 15 / TypeScript      │                   │
│   │                      │      │   - Dual-MCP Tool Multiplexer    │                   │
│   │                      │      │   - Visual Agent Execution Trace │                   │
│   │                      │      │   - Live Sandbox Security Gauge  │                   │
│   └──────────────────────┘      └─────────┬────────────────────────┘                   │
│                                           │                                            │
│                        egress-mesh        │                                            │
│           ════════════════════════════════╪════════════════════════════════════        │
│                                           │                      │                     │
│                                           │                      ▼                     │
│                                           │       ┌─────────────────────────────┐      │
│                                           │       │   Browser MCP (Port 8081)   │      │
│                                           │       │   - Isolated Web Scraper    │      │
│                                           │       │   - SSRF Protection Guard   │      │
│                                           │       │   - HTML-to-Markdown Clean  │      │
│                                           │       │   - user: 10002:10002       │      │
│                                           │       └─────────────────────────────┘      │
│                                           │                                            │
│                        ai-mesh (internal: true, zero internet egress)                  │
│                                           │                                            │
│                     ┌─────────────────────┴─────────────────────────┐                  │
│                     ▼                                               ▼                  │
│      ┌─────────────────────────────┐                 ┌───────────────┐                 │
│      │   Sandboxed MCP Server      │                 │ Ollama Engine │                 │
│      │   - Air-Gapped Code Runner  │                 │ (Local LLM)   │                 │
│      │   - read_only rootfs        │                 │ - Qwen 3.8 /  │                 │
│      │   - cap_drop: ALL           │                 │   Gemma       │                 │
│      │   - user: 10001:10001       │                 │ - Air-Gapped  │                 │
│      │   - tmpfs: /tmp (noexec)    │                 └───────────────┘                 │
│      │   - Safe Python Execution   │                                                   │
│      │   - Attestation Verifier    │                                                   │
│      └─────────────────────────────┘                                                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Network & Security Isolation Matrix

| Container | Network Placement | Filesystem Mode | Linux Capabilities | User ID | Role & Capabilities |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`web-ui`** | `ai-mesh`, `egress-mesh` | Read-Write | Default | Non-Root | Web Client & Multi-MCP Orchestrator |
| **`mcp-server`** | `ai-mesh` (`internal: true`) | **`read_only: true`** | **`cap_drop: ALL`** | **`10001:10001`** | Air-Gapped Python Code Runner |
| **`browser-mcp`** | `ai-mesh`, `egress-mesh` | Read-Only App | Default (No Privs) | **`10002:10002`** | Isolated Web Scraper & Search |
| **`ollama`** | `ai-mesh` (`internal: true`) | Volume Mounted | Default | Root (in-container) | Air-Gapped GPU Inference Engine |

* **Zero Egress Enforcement**: The `ai-mesh` network is configured with `internal: true`. Neither the LLM engine nor the code execution container can initiate or receive internet traffic.
* **Ephemeral Memory Buffer**: The MCP container mounts `/tmp` as a `tmpfs` (64MB) with `noexec,nosuid` to prevent malicious binary execution.

### 3.1 Host-Filesystem Write Trust Boundary (`./workspace:/workspace:rw`)

The MCP toolchain container mounts the host directory `./workspace` into `/workspace` with read-write access (`:rw`):
* **Design Rationale**: This direct bind mount enables seamless local pair programming. Code files, git feature branches, test suites, architecture diagrams (`.drawio.svg`), and learned agent skills (`.agent/skills/`) generated by the model are written directly to the host filesystem so the developer can review, inspect, and run them locally without manual exports.
* **Trust Implications & Blast Radius**:
  * Any tool execution by the autonomous agent (`workspace_write_file`, `workspace_run_command`) operates directly on files inside `./workspace` with the permissions of the host process running Docker.
  * While path traversal outside `/workspace` is strictly rejected by `resolveSafePath()` and container root is read-only, **any file within `./workspace` can be modified or overwritten** by the agent or by commands executed via `workspace_run_command`.
  * **Operational Hardening**:
    1. Never symlink sensitive host directories (such as `~/.ssh`, `~/.aws`, `~/.kube`, or system credentials) into `./workspace`.
    2. Treat `./workspace` as an untrusted code sandbox that is monitored via version control. Git initializes an automatic repository with commit history inside `/workspace` to allow tracking and reverting agent modifications.


---

## 4. Repository Structure

```text
local-agentic-sandbox/
├── README.md
├── ARCHITECTURE.md
├── docker-compose.yml
├── Makefile
├── mcp-server/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       └── tools/
│           ├── codeRunner.ts
│           └── attestation.ts
├── web-ui/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── api/
│   │       ├── chat/route.ts
│   │       └── sandbox-status/route.ts
│   └── components/
│       ├── ChatStream.tsx
│       ├── ExecutionTrace.tsx
│       └── SandboxGauge.tsx
└── docs/
    └── ADR-001-sandboxed-mcp.md
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

```bash
# 1. Pull the model into Ollama
docker compose up -d ollama
docker compose exec ollama ollama run qwen3.8

# 2. Build and launch all services
docker compose up --build -d

# 3. Verify security isolation
docker compose exec mcp-server id
# Returns: uid=10001 gid=10001

docker compose exec mcp-server ping -c 1 8.8.8.8
# Returns: Network unreachable (zero internet egress)
```
