# System Topology Matrix

Visual diagram: [docs/architecture.drawio.svg](./architecture.drawio.svg)

| Component | Runs Where | Ports | Talks To |
| :--- | :--- | :--- | :--- |
| **Operator (Browser / Mobile)** | External / LAN / Tailnet | HTTPS `:443` (via gateway) | `kind Gateway (nginx)` |
| **kind Gateway (nginx)** | Kubernetes (`local-agentic-sandbox` ingress) | `:80`, `:443` | `web-ui`, `jaeger` (`/jaeger/`) |
| **web-ui (Orchestrator)** | Kubernetes pod (`ns: local-agentic-sandbox`) | `:3000` | `Strata` (`:8080`), `mcp-runner` (`:3001`), `browser-mcp` (`:3002`), `host-bridge` (`:8765`), `otel-collector` (`:4318`) |
| **mcp-runner** | Kubernetes pod (read-only rootfs, `cap_drop: ALL`) | `:3001` | `workspace-pvc`, GitHub CIDRs (`:443` only per `network-policies.yaml`) |
| **browser-mcp** | Kubernetes pod (isolated, SSRF-guarded) | `:3002` | Public web (`:80`, `:443`; RFC 1918 blocked) |
| **otel-collector / Jaeger** | Kubernetes pod (`observability.yaml`) | `:4317`, `:4318`, `:16686` | `web-ui` (traces), `kind Gateway` (`/jaeger/`) |
| **Strata Inference Engine** | Host process (AMD RX 9070 XT, ROCm/HIP) | `:8080` | `web-ui` (via `strata-service` endpoint) |
| **Host Bridge** | Host process (sole external boundary) | `:8765` | `web-ui` (inbound), Host OS / git / GitHub / keyring (outbound, classifier-gated) |
