# System Topology Matrix

Visual diagram: [docs/architecture.drawio.svg](./architecture.drawio.svg)

| Component | Runs Where | Ports | Talks To |
| :--- | :--- | :--- | :--- |
| **Operator (Browser / Mobile)** | External / LAN / Tailnet | LAN `:80` / `:3000` (via bridge) | `LAN / tailnet bridge` -> `kind Gateway (nginx)` |
| **kind Gateway (nginx)** | Docker container on `kind` network (`scripts/kind-gateway`) | `:3001` | `web-ui` (NodePort `:30300`), `jaeger` (`/jaeger/` -> NodePort `:30686`) |
| **web-ui (Orchestrator)** | Kubernetes pod (`ns: local-agentic-sandbox`) | `:3000` (NodePort `:30300`) | `Strata` (`:8080`), `mcp-runner` (`:8080`), `browser-mcp` (`:8081`), `host-bridge` (`:8765`), `otel-collector` (`:4318`) |
| **mcp-runner** | Kubernetes pod (read-only rootfs, `cap_drop: ALL`) | `:8080` | `workspace-pvc`, GitHub CIDRs (`:443` only per `network-policies.yaml`) |
| **browser-mcp** | Kubernetes pod (isolated, SSRF-guarded) | `:8081` | Public web (`:80`, `:443`; RFC 1918 blocked) |
| **otel-collector / Jaeger** | Kubernetes pod (`observability.yaml`) | `:4317`, `:4318`, `:16686` | `web-ui` (traces), `kind Gateway` (`/jaeger/`) |
| **Strata Inference Engine** | Host process (AMD RX 9070 XT, ROCm/HIP) | `:8080` | `web-ui` (via `strata-service` endpoint) |
| **Host Bridge** | Host process (sole external boundary) | `:8765` | `web-ui` (inbound), Host OS / git / GitHub / keyring (outbound, classifier-gated) |
