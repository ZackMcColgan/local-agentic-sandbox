# Kubernetes Deployment Guide

This repo runs on **Kubernetes** (Docker Desktop) in the `local-agentic-sandbox` namespace.
Docker Compose is **not** used for the live deployment.

## Architecture

| Component | Location | Notes |
|-----------|----------|-------|
| web-ui | K8s (`local-agentic-sandbox`) | NodePort 30300; image `local-agentic-sandbox-web-ui:v1.0.0` with `imagePullPolicy: Never` |
| browser-mcp | K8s | Web search + page fetch |
| mcp-runner | K8s | Sandboxed code execution |
| qdrant | K8s | Semantic memory |
| otel-collector | K8s | Observability |
| strata | **Host** (native, not K8s) | K8s reaches it via `strata-service` (`host.docker.internal:8080`) |
| host-bridge | **Host** (native, not K8s) | K8s reaches it via `host-runner-service` (`host.docker.internal:8765`) |

Strata and host-bridge run natively on the host for GPU and OS keyring access.

## Prerequisites

### 1. Host Strata & Host-Bridge configuration (required)

K8s pods reach Strata on `:8080` and host-bridge on `:8765` via `host.docker.internal`.

**Verify:**
```powershell
netstat -an | Select-String "LISTENING" | Select-String "8080|8765"

kubectl exec -it deployment/web-ui -n local-agentic-sandbox -- wget -qO- http://strata-service:8080/health
kubectl exec -it deployment/web-ui -n local-agentic-sandbox -- wget -qO- http://host-runner-service:8765/health
```

### 2. Ingress controller (for phone/LAN access without port-forward)

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.1/deploy/static/provider/cloud/deploy.yaml
```

The repo includes `deploy/k8s/ingress.yaml` (nginx, SSL redirect off).

## Deploy

Recommended (builds from repo root, imports into the `desktop-control-plane` containerd node, updates the deployment image, and verifies rollout):

```bash
node scripts/deploy-cluster.js web-ui
# Or deploy all three container images (mcp-server, browser-mcp, web-ui):
node scripts/deploy-cluster.js all
```

Or via `make`:

```bash
# From repo root:
git checkout develop
git pull origin develop
make k8s-deploy
```

Manual equivalent (no `make` on Windows — run from repo root so workspace `COPY` paths resolve):
```powershell
docker build -t local-agentic-sandbox-web-ui:v1.0.0 -f web-ui/Dockerfile .
kubectl rollout restart deployment/web-ui -n local-agentic-sandbox
kubectl rollout status deployment/web-ui -n local-agentic-sandbox --timeout=300s
```

## Access

| Method | URL | Notes |
|--------|-----|-------|
| LAN / Gateway bridge (recommended) | `http://<host-ip>/` | Run `.\scripts\kind-gateway\start-gateway.ps1` + `node scripts/lan-bridge.js`; see [access-path.md](./access-path.md) |
| Ingress (with controller) | `http://<host-ip>/` | No port needed |
| Port-forward | `kubectl port-forward svc/web-ui 3001:3000 -n local-agentic-sandbox --address 0.0.0.0` | Then `http://<host-ip>:3001` |
| NodePort direct | `http://<host-ip>:30300` | Unreliable on Docker Desktop |

For persistent phone access without manual port-forward, create a Windows
Scheduled Task that runs the port-forward command at logon.

## Fresh install

```bash
# Build image from repo root first (imagePullPolicy: Never requires it locally)
docker build -t local-agentic-sandbox-web-ui:v1.0.0 -f web-ui/Dockerfile .

# Deploy everything
kubectl apply -k deploy/k8s
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Strata / host-bridge unreachable` | Host service not running or bound to loopback | Start Strata (`:8080`) / host-bridge (`:8765`) on host |
| Tasks stuck at 25%, milestones `pending` | Old image (pre-fix) | `make k8s-deploy` to rebuild |
| `kubectl` connection refused | Docker Desktop not running | Start Docker Desktop, wait for whale icon |
| UI not loading after deploy | Port-forward died | Restart port-forward |
| `make` not recognized (Windows) | No make on Windows | Use manual docker/kubectl commands above |
