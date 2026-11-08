# Web UI Access Path Architecture & Ops Guide

## Architecture Overview

The local agentic sandbox web UI is accessible over the local area network (LAN) via a multi-tier proxy architecture designed for high-concurrency streaming SSE resilience without depending on the fragile `kubectl port-forward` SPDY multiplexer.

```
+-----------------------------------------------------------------------------------------+
| HOST PC (Windows 11)                                                                    |
|                                                                                         |
|  Client (Phone/Browser)                                                                 |
|         │                                                                               |
|         ▼  http://192.168.50.254:80                                                     |
|  ┌───────────────────────────────┐                                                      |
|  │ scripts/lan-bridge.js         │ (Node.js reverse proxy on LAN IP)                    |
|  │ + GatewayWatchdog             │ (Probes :3001 every 5s; heals via Docker restart)    |
|  └──────────────┬────────────────┘                                                      |
|                 │                                                                       |
|                 ▼  http://127.0.0.1:3001                                                |
|  ┌───────────────────────────────┐                                                      |
|  │ Docker Desktop Port Forward   │                                                      |
|  └──────────────┬────────────────┘                                                      |
+─────────────────┼───────────────────────────────────────────────────────────────────────+
                  │ (Docker Bridge: network "kind")
                  ▼
+─────────────────┼───────────────────────────────────────────────────────────────────────+
| DOCKER NETWORK "kind" (172.20.0.0/16)                                                   |
|                                                                                         |
|  ┌───────────────────────────────┐                                                      |
|  │ kind-gateway (nginx:alpine)   │  Listening on container :3001                        |
|  │ (Config: scripts/kind-gateway)│  proxy_buffering off, HTTP/1.1                       |
|  └──────────────┬────────────────┘                                                      |
|                 │                                                                       |
|                 ▼  http://desktop-control-plane:30300                                   |
|  ┌───────────────────────────────┐                                                      |
|  │ desktop-control-plane NodePort│  Kubernetes Service NodePort 30300                   |
|  │ (kind node container)         │                                                      |
|  └──────────────┬────────────────┘                                                      |
|                 │ kube-proxy iptables                                                   |
|                 ▼                                                                       |
|  ┌───────────────────────────────┐                                                      |
|  │ web-ui Pod (:3000)            │  Next.js Server in local-agentic-sandbox             |
|  └───────────────────────────────┘                                                      |
+-----------------------------------------------------------------------------------------+
```

---

## Configuration & Assets

- **Nginx Configuration**: [`scripts/kind-gateway/nginx.conf`](file:///C:/Users/zackm/Desktop/repos/local-agentic-sandbox/scripts/kind-gateway/nginx.conf)
  - HTTP/1.1 reverse proxy to `$node_upstream http://desktop-control-plane:30300`.
  - Dynamic DNS resolution using Docker's embedded DNS (`127.0.0.11 valid=5s`).
  - Buffering fully disabled (`proxy_buffering off; proxy_request_buffering off; chunked_transfer_encoding on; add_header X-Accel-Buffering no;`).
  - Stream timeouts set to `86400s` (24h) to prevent proxy severance during long-running reasoning tasks.
  - Upstream connect timeout set to `3s`.
- **Gateway Launcher Script**: [`scripts/kind-gateway/start-gateway.ps1`](file:///C:/Users/zackm/Desktop/repos/local-agentic-sandbox/scripts/kind-gateway/start-gateway.ps1)
  - Idempotent container lifecycle manager. Runs `nginx:alpine` named `kind-gateway` attached to network `kind`.
  - Mounts `nginx.conf` as read-only.
  - Automatically redeploys if container is missing or configuration hash changes.
- **Gateway Teardown Script**: [`scripts/kind-gateway/stop-gateway.ps1`](file:///C:/Users/zackm/Desktop/repos/local-agentic-sandbox/scripts/kind-gateway/stop-gateway.ps1)
  - Forcibly removes container (`docker rm -f kind-gateway`).

---

## Mode Switch: Gateway vs Legacy Port-Forward

The system supports two access path modes controlled by environment variable `ACCESS_PATH_MODE`:
1. `gateway` (default): Runs `kind-gateway` container; bypasses `kubectl port-forward`.
2. `legacy-port-forward`: Runs legacy `kubectl port-forward svc/web-ui 3001:3000` child process.

### Operational Switching via AI-ON / AI-OFF
```powershell
# Default: Start in gateway mode
C:\AI\ai-control\AI-ON.ps1

# Rollback: Start in legacy port-forward mode
C:\AI\ai-control\AI-ON.ps1 -AccessPathMode legacy-port-forward

# Teardown matching mode
C:\AI\ai-control\AI-OFF.ps1 -AccessPathMode gateway
C:\AI\ai-control\AI-OFF.ps1 -AccessPathMode legacy-port-forward
```

---

## Gateway Watchdog & Auto-Healing

[`scripts/lan-bridge.js`](file:///C:/Users/zackm/Desktop/repos/local-agentic-sandbox/scripts/lan-bridge.js) includes an active `GatewayWatchdog` class:
- **Active Only in Gateway Mode**: Ignored when `ACCESS_PATH_MODE=legacy-port-forward`.
- **Health Probing**: Sends an HTTP HEAD request to `http://127.0.0.1:<TARGET_PORT>/` every 5 seconds with a 3-second timeout.
- **Healing Trigger**: Triggered after **2 consecutive failures** (total detection budget ≤ 11 seconds).
- **Healing Action**: Executes `docker restart kind-gateway` (or `start-gateway.ps1` if container is missing).
- **Log Format**: `[lan-bridge:watchdog] kind-gateway unresponsive (probe status ...). Triggering container heal...`
- **Exhaustion Guard**: Sliding window allows at most 3 heals per 5 minutes. If exceeded, logs `[lan-bridge:watchdog] WATCHDOG EXHAUSTED: 3 heals in last 5m. Halting automated restarts.`

---

## Crux Diagnostic Command

To verify direct layer-3/layer-4 connectivity between the Docker network and the Kubernetes NodePort without going through the host network:

```powershell
docker run --rm --network kind nginx:alpine wget -qO- --timeout=3 http://desktop-control-plane:30300/
```

- **Expected Output**: Returns raw HTML from Next.js (HTTP 200).
- If this command hangs or fails, the issue is internal to the Kind node, kube-proxy, or the pod deployment, not the host access path.
