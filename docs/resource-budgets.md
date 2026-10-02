# Resource Budgets & Two-Tier Sandbox Architecture

**Target Environment**: AMD Ryzen 7 5700X3D, AMD Radeon RX 9070 XT 16GB VRAM, ROCm, Ollama, Local Kubernetes, Next.js 15, Node.js 22 LTS.

---

## 1. VRAM & Compute Budget

### 1.1 Hardware Baseline & Allocation
- **GPU**: AMD Radeon RX 9070 XT (16 GB GDDR6 VRAM).
- **Driver / Runtime**: AMD ROCm runtime with direct host passthrough to Ollama inference engine.
- **Model Roster**: User-managed via configuration (e.g. Qwen 3.8 / Gemma 4). The platform reads model names dynamically from config and does not prescribe hardcoded rosters.

### 1.2 Concurrency & Headroom
- Concurrency cap is derived dynamically at runtime from available VRAM headroom.
- Subagents (Explorer, Builder, Critic, Recorder) share the local inference pool sequentially or in bounded batches.

### 1.3 Cancellation & Zero VRAM Leakage Guarantee
- Every running worker session is bound to an `AbortController` cancellation token.
- Triggering cancellation (e.g. via mobile Web UI kill switch or API `/api/tasks/cancel`) immediately signals Ollama to abort streaming inference, halts child tool processes, and recovers active worker count to 0 (idle) in under 30 seconds.

---

## 2. Disk & Build Cache Budget

### 2.1 20 GB Disk Budget Cap
- Build artifacts and package manager caches (`node_modules`, `cargo target/`, `.cache/pip`, Go module cache) must **never** be checked into the repository or left in host directories.
- Caches are persisted exclusively to a dedicated named Docker volume (`build-cache`) or Kubernetes PersistentVolumeClaim (`build-cache-pvc`).
- Total cache allocation is strictly capped at **20 GB**.

### 2.2 7-Day Automatic Cache Pruning
- To prevent disk exhaustion during multi-day autonomous overnight operations, the system implements automated cache pruning:
  - Cache entries with modification times older than **7 days** (`CACHE_MAX_AGE_DAYS = 7`) are automatically pruned.
  - Automated pruning routines run periodically and prior to large compilation jobs via `pruneBuildCache()`.

---

## 3. Two-Tier Sandbox Architecture

To reconcile security isolation with the practical necessity of software builds (`npm install`, `pip install`), the system divides workloads across two distinct sandbox tiers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TWO-TIER SANDBOX ARCHITECTURE                   │
├──────────────────────────────────┬─────────────────────────────────────┤
│        BUILD TIER (New)          │         EXEC TIER (Existing)        │
├──────────────────────────────────┼─────────────────────────────────────┤
│ • Pre-baked toolchain images     │ • Hardened runtime container        │
│   (Node 22, Python 3.12, Go,     │   (sandboxed-mcp-server)            │
│    Rust) in deploy/              │ • read_only: true root filesystem   │
│ • Toolchain declared in SPEC.md  │ • cap_drop: ALL linux capabilities  │
│ • Writable /workspace volume     │ • tmpfs: /tmp (noexec, nosuid)      │
│ • Named build-cache volume (20GB)│ • UID 10001 (unprivileged)          │
│ • Egress allowlist strictly to   │ • Zero internet egress              │
│   package registries (npm, PyPI, │   (internal: true, air-gapped)      │
│   Crates, Go proxy) & GitHub     │ • Blocks npm install, pip, compiler │
│ • No secrets mounted             │ • Used for test running, code exec, │
│ • No host access beyond workspace│   and untrusted evaluation          │
└──────────────────────────────────┴─────────────────────────────────────┘
```

### 3.1 Pre-Baked Toolchain Images
The overnight builder never runs `apt-get` or installs compilers mid-run at 2 AM. All toolchains are pre-baked and versioned under `deploy/`:
- `deploy/builder-node/Dockerfile`: `builder-node:22` (Node.js 22 LTS, npm, yarn, pnpm)
- `deploy/builder-python/Dockerfile`: `builder-python:3.12` (Python 3.12, pip, poetry, build-essential)
- `deploy/builder-go/Dockerfile`: `builder-go:latest` (Go 1.23 toolchain)
- `deploy/builder-rust/Dockerfile`: `builder-rust:latest` (Rust 1.80 stable toolchain)

### 3.2 Egress Registry Allowlist
The build tier egress proxy permits traffic exclusively to approved package registries:
- `registry.npmjs.org`, `registry.yarnpkg.com`
- `pypi.org`, `files.pythonhosted.org`
- `crates.io`, `static.crates.io`
- `proxy.golang.org`, `sum.golang.org`
- `github.com` (for source repo clone and submodules)

All other outbound requests (such as arbitrary external IP addresses, cloud metadata endpoints `169.254.169.254`, and private LAN subnets) are dropped by default network policies.
