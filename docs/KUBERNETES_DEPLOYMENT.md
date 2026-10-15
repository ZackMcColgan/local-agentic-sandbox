# Kubernetes Deployment Guide

This repo runs on **Kubernetes** (Docker Desktop) in the `local-agentic-sandbox` namespace.
Docker Compose is **not** used for the live deployment.

## Architecture

| Component | Location | Notes |
|-----------|----------|-------|
| web-ui | K8s (`local-agentic-sandbox`) | NodePort 30300; image `local-agentic-sandbox-web-ui:v2.7-unified` with `imagePullPolicy: Never` |
| browser-mcp | K8s | Web search + page fetch |
| mcp-runner | K8s | Sandboxed code execution |
| qdrant | K8s | Semantic memory |
| otel-collector | K8s | Observability |
| ollama | **Host** (native, not K8s) | K8s reaches it via `host.docker.internal:11434` |

The in-cluster `ollama-rocm-gpu` deployment is intentionally scaled to 0.
Ollama runs natively on the host for GPU access.

## Prerequisites

### 1. Ollama host configuration (required)

K8s pods reach Ollama via `host.docker.internal`. Ollama's DNS-rebinding
protection 403s any non-loopback Host header unless it's bound to `0.0.0.0`.

**Windows (Machine-level, survives reboots):**
```powershell
# Admin PowerShell
[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "Machine")
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "*", "Machine")
```

Then fully quit Ollama (tray icon → Quit) and restart it.

**Verify:**
```powershell
netstat -an | Select-String "LISTENING" | Select-String "11434"
# Want: 0.0.0.0:11434  (not 127.0.0.1:11434)

kubectl exec -it deployment/web-ui -n local-agentic-sandbox -- wget -qO- http://ollama-service:11434/api/tags
# Want: JSON model list (not 403)
```

### 2. Ingress controller (for phone/LAN access without port-forward)

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.1/deploy/static/provider/cloud/deploy.yaml
```

The repo includes `deploy/k8s/ingress.yaml` (nginx, SSL redirect off).

## Deploy

```bash
# From repo root:
git checkout develop
git pull origin develop
make k8s-deploy
```

This builds the Docker image locally and rollout-restarts the K8s deployment.
(`imagePullPolicy: Never` picks up the local image directly.)

Manual equivalent (no `make` on Windows):
```powershell
docker build -t local-agentic-sandbox-web-ui:v2.7-unified -f web-ui/Dockerfile web-ui
kubectl rollout restart deployment/web-ui -n local-agentic-sandbox
kubectl rollout status deployment/web-ui -n local-agentic-sandbox --timeout=300s
```

## Access

| Method | URL | Notes |
|--------|-----|-------|
| Ingress (with controller) | `http://<host-ip>/` | No port needed |
| Port-forward | `kubectl port-forward svc/web-ui 3001:3000 -n local-agentic-sandbox --address 0.0.0.0` | Then `http://<host-ip>:3001` |
| NodePort direct | `http://<host-ip>:30300` | Unreliable on Docker Desktop |

For persistent phone access without manual port-forward, create a Windows
Scheduled Task that runs the port-forward command at logon.

## Fresh install

```bash
# Build image first (imagePullPolicy: Never requires it locally)
docker build -t local-agentic-sandbox-web-ui:v2.7-unified -f web-ui/Dockerfile web-ui

# Deploy everything
kubectl apply -k deploy/k8s
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Ollama engine returned 403` | Ollama bound to loopback | Set `OLLAMA_HOST=0.0.0.0:11434`, restart Ollama |
| Tasks stuck at 25%, milestones `pending` | Old image (pre-fix) | `make k8s-deploy` to rebuild |
| `kubectl` connection refused | Docker Desktop not running | Start Docker Desktop, wait for whale icon |
| UI not loading after deploy | Port-forward died | Restart port-forward |
| `make` not recognized (Windows) | No make on Windows | Use manual docker/kubectl commands above |
