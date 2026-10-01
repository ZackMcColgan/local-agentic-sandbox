# Antigravity Autonomous Execution Spec: local-agentic-sandbox v2
**Self-Healing Autonomous Developer Engine ("Private Claude Code")**  
*Target Environment: Local Workstation (AMD Ryzen 7 5700X3D, Radeon RX 9070 XT 16GB VRAM, ROCm, Ollama, Docker / Local Kubernetes, Next.js 15, Node.js 22 LTS, TypeScript)*  
*Remote Control Interface: Mobile Web at `http://192.168.50.254:3000` (Maximized Vertical Viewport, Zero UI Pills)*

---

## 1. System Mission & Core Philosophy

### 1.1 Mandatory Git Branching Prerequisite
**CRITICAL INSTRUCTION FOR ANTIGRAVITY:**
Before modifying any files or undertaking this v2 revision, Antigravity **MUST** branch off of `main`:
```bash
git checkout main
git pull origin main
git checkout -b feat/v2-autonomous-platform
```
All commits, tests, and task iterations must occur exclusively on `feat/v2-autonomous-platform`. Main remains untouched until all 3 phases are completely built, integrated, and verified.

### 1.2 The Objective
Transform `local-agentic-sandbox` from a basic Ollama chat interface into an unconstrained, self-correcting **Autonomous Engineering Agent** running on 100% free, private local compute. The agent must be capable of ingesting architectural diagrams and draw.io exports, cloning repositories, creating feature branches, editing codebases, executing test suites in an isolated container, diagnosing failures, and self-correcting in an iterative loop until all tests pass.

### 1.3 The "Unconstrained Execution" Principle
* **No Micro-Approval Bottlenecks**: The agent runs inside an isolated, safe execution sandbox. It does **not** stop for manual one-tap approval on every file edit or command run.
* **Autonomous Feedback Loop**: The agent writes code, runs `pytest`/`npm test`/`cargo test`, inspects the exit code and stderr, refines its implementation, and loops autonomously.
* **Reviewable Output**: What gets reviewed by the user (via phone or desktop) is the **final output**: the live test results, the git diff, the created branch, and the execution trace.
* **Zero UI Clutter / Zero Pills**: No suggestion chips, prompt pills, or floating buttons taking up vertical screen real estate. The mobile UI must provide a clean, distraction-free, full-height conversational and terminal viewport.

### 1.4 Persistent Storage & Workspace Boundary
* **Shared Persistent Workspace (`/workspace`)**:
  * Instead of a 64MB ephemeral tmpfs, mount a persistent host volume or Kubernetes PVC into the sandboxed runner at `/workspace`.
  * The container rootfs remains strictly **`read_only: true`** (OS security), but `/workspace` is mounted read-write for unprivileged user `10001:10001`.
  * All generated code, Git branches, test suites, architecture documents, and `.drawio.svg` diagrams are stored directly in `/workspace` and persist permanently on the host machine.
* **Multimodal Vision Pipeline: Gemma vs. Hermes**:
  * **Vision Ingestion Engine (`gemma4:e4b`)**: Gemma is natively multimodal and handles visual architecture diagrams, draw.io exports, whiteboard sketches, and UI wireframes. When an image or diagram is attached, Gemma ingests the image, extracts the system architecture, component boundaries, and API schemas, and converts them into structured markdown specs for the coding loop.
  * **Code & Tool-Calling Engine (`hermes3:8b` / `qwen3.8:27b`)**: Consumes the extracted spec, navigates the `/workspace` filesystem, generates files, executes commands, and runs the self-correcting test loop.

---

## 2. Multi-Phase Implementation Plan

```text
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Tri-Mode Model Dispatcher & Multimodal Ingestion Engine       │
│ • UI Segmented Control: [ Auto | Flash | Pro ] (Zero Pills / Clean)   │
│ • Gemma 4 Multimodal Ingestion (draw.io, arch diagrams, UI mocks)      │
│ • Fast Triage & Loop Orchestration (~80 tok/s via Gemma 4 / Hermes 3) │
│ • Deep Reasoning Synthesis (Qwen 3.8 / Hermes 3 70B)                  │
│ • Native Ollama Structured Function-Calling JSON Parser                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Autonomous Git & Workspace Developer Engine + Clean Workbench │
│ • Persistent /workspace Volume & Whole-Repo Indexing (Tree & Grep)     │
│ • Full Workspace & Git MCP Tools (read, write, bash/test, branch)       │
│ • Self-Correcting Execution Engine (Loop until exit_code == 0)         │
│ • Clean Mobile UI: Full-Height Chat, Active Git Branch Badge,          │
│   Collapsible Terminal Stream, Visual Diff Inspector (NO PILLS)        │
│ • Hermes Agent Self-Improving Skill Loop Architecture Compatibility   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Local Kubernetes (KinD / k3s) & OpenTelemetry Observability   │
│ • Kubernetes Manifests & Helm Chart (UI, MCP Runner, Ollama)           │
│ • Namespace Micro-Segmentation & Calico/Cilium NetworkPolicies         │
│ • OpenTelemetry Distributed Tracing (LLM -> MCP -> K8s Runner)         │
│ • In-UI Trace Waterfall & Hardware Telemetry Synchronization           │
└────────────────────────────────────────────────────────────────────────┘
```

---

# PHASE 1: Tri-Mode Model Dispatcher & Multimodal Architecture Ingestion

### Objective
Eliminate latency bottlenecks by implementing an intelligent **Auto** mode that uses `gemma4:e4b` for multimodal diagram ingestion, fast planning, and triage, reserving deep reasoning models (`qwen3.8:27b` or `hermes3:70b-q3_k_m`) for complex architectural synthesis, while preserving manual **Flash** and **Pro** overrides.

### Task 1.1: Clean Mobile UI Segmented Control (`web-ui/components/ModelSelector.tsx`)
* **File to modify/create**: `web-ui/components/ModelSelector.tsx` (and update `web-ui/app/page.tsx` header).
* **Specifications**:
  * Clean, minimal 3-way segmented control in header: `[ Auto (Hierarchical) | Flash | Pro ]`.
  * **Strict Clean UI Constraint**: Completely eliminate all prompt pills, suggestion bubbles, and preset chips (`PromptPills.tsx`, `QuickPrompts.tsx`). Maximize vertical space for message history and streaming terminals.
  * Mobile-responsive layout (optimized for touch targets at 360px–420px viewport without taking vertical height).
  * Visual indicators:
    * `Auto`: Purple gradient badge with sparkle icon (`✨ Auto`).
    * `Flash`: Amber badge with lightning icon (`⚡ Flash ~80 t/s`).
    * `Pro`: Blue badge with chip icon (`🧠 Pro`).
  * Persist the selected mode in `localStorage` under `local_agent_mode` (default: `'auto'`).

### Task 1.2: Multimodal Diagram Ingestion Pipeline
* **File to modify/create**: `web-ui/lib/visionProcessor.ts`.
* **Specifications**:
  * When a user uploads an architecture diagram (PNG, JPG, SVG, or draw.io export):
    1. Route the image payload directly to `gemma4:e4b` via Ollama's vision API.
    2. Prompt Gemma to extract:
       - Component boundaries and services.
       - Network protocol endpoints (REST, gRPC, SSE, Kafka topics).
       - Data flow and database schemas.
    3. Return a standardized markdown architecture specification.
    4. Inject this specification as context for the downstream coding and tool execution loop.

### Task 1.3: Hierarchical Auto-Router Logic (`web-ui/app/api/chat/route.ts`)
* **File to modify**: `web-ui/app/api/chat/route.ts`.
* **Specifications**:
  * **When `mode === 'flash'`**: Route directly to fast model (`gemma4:e4b` or `hermes3:8b`).
  * **When `mode === 'pro'`**: Route directly to reasoning model (`qwen3.8:27b-q3_k_m`).
  * **When `mode === 'auto'`**:
    1. **Triage Step**: Query fast model with a lean classification prompt:
       ```text
       Classify this user request into COMPLEXITY: 'SIMPLE_EXECUTION' or 'DEEP_SYNTHESIS'.
       SIMPLE_EXECUTION: file navigation, git branch operations, running tests/commands, inspecting logs, small bug fixes.
       DEEP_SYNTHESIS: novel system architecture, complex algorithm design, full module refactoring.
       Output JSON strictly: {"complexity": "...", "reasoning": "..."}
       ```
    2. If `complexity === 'SIMPLE_EXECUTION'`, execute via Flash engine at ~80 tok/s.
    3. If `complexity === 'DEEP_SYNTHESIS'`, dispatch initial high-level architectural plan to Pro engine.
    4. **Auto-Escalation**: If the fast engine executes a test suite and the tests fail twice consecutively, package the failure diff and escalate to the Pro engine for root-cause diagnosis.

### Task 1.4: Native Ollama & Hermes Structured Tool-Calling Parser
* **File to modify**: `web-ui/app/api/chat/route.ts` & `web-ui/lib/ollamaClient.ts`.
* **Specifications**:
  * Do **not** rely on prompt-engineered XML tags (e.g. `<tool_call>`).
  * Support both standard OpenAI-compatible tool schemas and Nous Research Hermes function-calling format (`tools` array parameter in Ollama).
  * In the streaming response parser, check for `message.tool_calls`. When present:
    1. Send an immediate SSE event to the client UI: `event: tool_start`, data: `{ tool: toolName, args: toolArgs }`.
    2. Forward the call over HTTP/SSE to `mcp-server:8080/messages`.
    3. Receive tool output `{ stdout, stderr, exit_code }`.
    4. Send an SSE event to the client UI: `event: tool_end`, data: `{ stdout, stderr, exit_code }`.
    5. Append `{ role: 'tool', content: toolResult }` to the message history and continue the generation loop automatically.

### Task 1.5: Acceptance Criteria & Automated Verification
* [ ] Running `npm run build` in `web-ui` completes with 0 TypeScript or lint errors.
* [ ] UI contains 0 prompt pills or floating suggestion buttons.
* [ ] Uploading a sample architecture diagram extracts a structured markdown component spec via `gemma4:e4b`.
* [ ] Selecting `Flash` triggers fast model with first token latency < 500ms.
* [ ] Selecting `Pro` triggers deep reasoning model.
* [ ] Selecting `Auto` routes a simple prompt ("Show git status and files") to Flash model in < 2 seconds.

---

# PHASE 2: Autonomous Git & Workspace Developer Engine + Clean Workbench

### Objective
Empower the agent to function as a complete autonomous developer (Claude Code equivalent) with full workspace awareness, persistent storage for documents and draw.io diagrams, branch management, autonomous test-driven execution, and a mobile-friendly, clutter-free UI.

### Task 2.1: Comprehensive Workspace, Search & Git MCP Server Tools (`mcp-server/src/tools/`)
* **Directory**: `mcp-server/src/tools/`.
* **Tools to Implement**:
  1. **`workspace_get_tree`**:
     * Args: `max_depth` (default 3), `sub_path` (optional).
     * Returns compact directory tree (skipping `node_modules`, `.git`, `__pycache__`) providing the agent full repo structure in ~300 tokens.
  2. **`workspace_grep`**:
     * Args: `pattern`, `file_glob` (optional).
     * Executes fast regex/substring search (via `ripgrep` or grep) across `/workspace`. Returns matching file paths and line snippets.
  3. **`workspace_read_file`**:
     * Args: `path` (relative to `/workspace`), `start_line` (optional), `end_line` (optional).
     * Returns file content with line numbers. Rejects path traversal outside `/workspace`.
  4. **`workspace_write_file`**:
     * Args: `path`, `content`, `create_dirs` (boolean).
     * Atomically writes file to `/workspace`. Rejects path traversal. Supports code files, Markdown documentation, and `.drawio.svg` / `.drawio` XML.
  5. **`workspace_run_command`**:
     * Args: `command` (e.g. `pytest tests/`, `npm test`, `python3 script.py`), `timeout_seconds` (default 30).
     * Executes inside `/workspace`. Returns `{ stdout, stderr, exit_code, execution_time_ms }`.
  6. **`git_status` & `git_diff`**:
     * Args: `cached` (boolean).
     * Returns current git branch, uncommitted files, and colored unified diff.
  7. **`git_checkout_branch`**:
     * Args: `branch_name`, `create_new` (boolean).
     * Creates and switches to an autonomous feature/fix branch (e.g. `agent/add-jwt-rotation`).
  8. **`git_commit`**:
     * Args: `message`.
     * Adds modified files and commits to the local branch.

### Task 2.2: Autonomous Self-Correcting Execution Engine (`web-ui/lib/agentEngine.ts`)
* **Specifications**:
  * Implement the Autonomous Iteration Loop:
    ```typescript
    while (iteration < MAX_ITERATIONS (default: 8)) {
      1. Model receives workspace tree + current prompt/objective.
      2. Model chooses action: grep code, read file, write file, or run test command.
      3. If model writes code -> immediately execute associated test suite.
      4. If test exit_code === 0 -> Break loop, generate victory summary & git diff.
      5. If test exit_code !== 0 -> Feed stderr + failed assertions back into context.
      6. Loop autonomously without prompting user for permission.
    }
    ```
  * Safety limits: Set `MAX_ITERATIONS = 8` and `COMMAND_TIMEOUT = 45s` to prevent infinite loops.

### Task 2.3: Clean Mobile UI Workbench (NO PILLS, Maximized Canvas)
* **Specifications**:
  1. **Completely Remove All Pills**:
     * Strip out all suggestion pills (`PromptPills.tsx`, `Web Research & Facts`, `Python Sandbox Test`, `Verify Zero Egress`).
     * Ensure chat input sits directly above the keyboard with maximum vertical scroll space for code and traces.
  2. **Active Branch Header Badge**:
     * Top header displays a single compact indicator: `🌿 branch: agent/feature-xyz` with quick toggle to view diff.
  3. **Live Collapsible Terminal Stream (`ExecutionTrace.tsx`)**:
     * Compact terminal widget that streams `stdout`/`stderr` in real time with ANSI colors when `workspace_run_command` executes.
     * Auto-expands during execution and collapses to a 1-line status bar upon test success.
  4. **Visual Diff & Artifact Inspector (`DiffViewer.tsx`)**:
     * Clean collapsible card rendering unified additions and deletions (`+ green`, `- red`) so user can review from phone without leaving chat.
     * Inline SVG preview for any generated `.drawio.svg` architecture diagrams.

### Task 2.4: Nous Research "Hermes Agent" Architecture Integration
* **Architecture Alignment with Hermes Agent (`NousResearch/hermes-agent`)**:
  * Support running **Hermes 3** (`hermes3:8b` / `hermes3:70b-q3_k_m`) via Ollama as an alternative drop-in inference engine. Hermes 3 is purpose-built for zero-alignment refusals, precise function-calling schemas, and multi-turn agentic loops.
  * Integrate Hermes Agent's **Self-Improving Skill Loop Pattern**:
    * When the agent successfully solves a novel coding or debugging task across multiple iterations, it summarizes the solution into a reusable skill markdown file in `/workspace/.agent/skills/<skill-name>.md`.
    * Subsequent agent runs inject matching `.agent/skills/` into the system prompt, reducing token consumption and preventing repeat errors.

### Task 2.5: Acceptance Criteria & Automated Verification
* [ ] The MCP server registers all 8 workspace/git/search tools on startup.
* [ ] Zero prompt pills appear anywhere in the UI.
* [ ] The agent autonomously clones or checks out a local test repository, creates a branch `agent/test-suite`, writes a Python file with a failing test, executes `pytest`, detects the error, fixes the code, and passes `pytest` without user intervention.
* [ ] Generated `.drawio.svg` diagrams persist in `/workspace/docs/` and render preview in the UI.
* [ ] The mobile UI renders the live terminal output and displays the resulting git diff clearly.

---

# PHASE 3: Local Kubernetes (KinD / k3s) Deployment & OpenTelemetry Observability

### Objective
Package the entire multi-agent platform for local Kubernetes, implement strict zero-egress network policies on execution pods, and instrument the entire flow with OpenTelemetry distributed tracing.

### Task 3.1: Kubernetes Manifests & Helm Chart (`deploy/k8s/`)
* **Directory**: `deploy/k8s/` or `deploy/helm/local-agentic-sandbox/`.
* **Components**:
  1. **Namespace**: `local-agentic-sandbox`.
  2. **`web-ui` Deployment & Service**:
     * NodePort or ClusterIP with Ingress on port 3000.
     * Environment variables for Ollama endpoint and MCP server address.
  3. **`mcp-runner` Deployment & Service**:
     * PersistentVolumeClaim (`pvc-workspace`) mounted at `/workspace` (persisting all code, docs, and diagrams to host storage).
     * Read-only root filesystem (`securityContext.readOnlyRootFilesystem: true`).
     * Dropped capabilities (`securityContext.capabilities.drop: ["ALL"]`).
     * Run as non-root user (`securityContext.runAsUser: 10001`).
  4. **`ollama` Deployment / Host Passthrough Service**:
     * Support connecting to host Ollama (with direct ROCm AMD GPU acceleration) via `host.docker.internal` or dedicated GPU pod with `k8s.amd.com/gpu`.

### Task 3.2: Kubernetes NetworkPolicies for Sandbox Isolation (`deploy/k8s/network-policies.yaml`)
* **Specifications**:
  * Create `NetworkPolicy` for `mcp-runner`:
    * Ingress: Only allowed from `web-ui` Pods on port 8080.
    * Egress:
      * Allow DNS (port 53).
      * Allow GitHub HTTPS (port 443 to `github.com` IP CIDRs) for git clone/push if remote syncing is enabled.
      * Block all arbitrary outbound internet access (`default-deny-egress`).

### Task 3.3: OpenTelemetry Distributed Tracing Instrumentation
* **Libraries**: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`.
* **Traced Workflow**:
  * Root Span: `agent.turn` (Prompt from mobile client).
    * Child Span 1: `router.triage` (Flash model decision latency & token metrics).
    * Child Span 2: `model.reasoning` (Pro model / Hermes execution).
    * Child Span 3: `mcp.tool_call` (Tool name, parameters, execution time).
    * Child Span 4: `sandbox.bash_exec` (Command runtime, exit code, memory usage).
    * Child Span 5: `model.synthesis` (Final streaming response to UI).
* **Local Collector**: Deploy a lightweight Jaeger or Grafana Tempo instance via Helm in `deploy/k8s/observability.yaml`.

### Task 3.4: In-UI Trace Waterfalls
* **Specifications**:
  * Add a **Telemetry & Traces** tab in the Next.js UI (`/sys` or drawer).
  * Expose an API endpoint `/api/traces?sessionId=...` reading from the local OTel collector.
  * Render an interactive Gantt-chart waterfall showing exactly where every millisecond was spent during the agent's autonomous loop.

---

## 3. Autonomous Execution & Verification Directives for Antigravity

When running this spec using the Antigravity CLI (`sbx run` or terminal):

1. **Branching Enforcement**: Antigravity **MUST** execute `git checkout -b feat/v2-autonomous-platform` before touching any code files.
2. **Sequential Phase Execution**: Execute Phase 1 completely, run tests, and verify build before proceeding to Phase 2.
3. **Deterministic Verification**:
   * After Phase 1: Run `curl -X POST http://localhost:3000/api/chat -d '{"mode":"auto","messages":[{"role":"user","content":"ping"}]}'` and assert response time < 2s. Verify no prompt pills render on `GET http://localhost:3000`.
   * After Phase 2: Run the automated self-correction test:
     ```bash
     docker compose exec mcp-server npm test
     ```
   * After Phase 3: Verify Kubernetes cluster health and network isolation:
     ```bash
     kubectl get pods -n local-agentic-sandbox
     kubectl describe networkpolicy -n local-agentic-sandbox
     ```
4. **Commit Cadence**: Commit cleanly after completing each task with semantic commit messages (e.g. `feat(router): implement hierarchical auto mode dispatcher`).
