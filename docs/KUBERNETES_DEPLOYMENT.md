# Kubernetes Deployment Guide

This repo runs on **Kubernetes** (Docker Desktop) in the `local-agentic-sandbox` namespace.
Docker Compose is **not** used for the live deployment.

## Architecture

| Component      | Location                      | Notes                                                                                                                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web-ui         | K8s (`local-agentic-sandbox`) | NodePort 30300; image `local-agentic-sandbox-web-ui:v-<sha>-<timestamp>` (built & imported by `scripts/deploy-cluster.js`) with `imagePullPolicy: Never` |
| browser-mcp    | K8s                           | Web search + page fetch                                                                                                                                  |
| mcp-runner     | K8s                           | Sandboxed code execution                                                                                                                                 |
| qdrant         | K8s                           | Semantic memory                                                                                                                                          |
| otel-collector | K8s                           | Observability                                                                                                                                            |
| strata         | **Host** (native, not K8s)    | K8s reaches it via `strata-service` (`host.docker.internal:8080`)                                                                                        |
| host-bridge    | **Host** (native, not K8s)    | K8s reaches it via `host-runner-service` (`host.docker.internal:8765`)                                                                                   |

Strata and host-bridge run natively on the host for GPU access and host git/command execution. Internal service tokens (`sandbox-mcp`, `sandbox-host-runner`, `sandbox-llm-supervisor`, and optional `sandbox-telegram`) are supplied to `web-ui` via Kubernetes Secrets (`deploy/k8s/web-ui.yaml`), while `host-bridge` reads its shared secret from host environment variables.

> **Stage flags:** All autonomous post-PR stage flags (`DISPATCHER_AUTO_ISSUE`, `BOARD_STAGE_FLOW_MONITOR`, `BOARD_STAGE_REVIEWER_GATE`, `BOARD_STAGE_SELF_DEPLOY`, `SELF_DEPLOY_ENABLED`) default to **OFF (shadow mode)**.

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

Manual equivalent (Windows — run from repo root so workspace `COPY` paths resolve, then import into the `desktop-control-plane` containerd node because `imagePullPolicy: Never` reads from `k8s.io` containerd storage):

```powershell
docker build -t local-agentic-sandbox-web-ui:manual -f web-ui/Dockerfile .
docker save local-agentic-sandbox-web-ui:manual -o web-ui.tar
docker exec desktop-control-plane mkdir -p /images
docker cp web-ui.tar desktop-control-plane:/images/image.tar
docker exec desktop-control-plane ctr -n k8s.io images import /images/image.tar
docker exec desktop-control-plane rm -f /images/image.tar
Remove-Item web-ui.tar
kubectl set image deployment/web-ui web-ui=local-agentic-sandbox-web-ui:manual -n local-agentic-sandbox
kubectl rollout status deployment/web-ui -n local-agentic-sandbox --timeout=300s
```

## Access

| Method                             | URL                                                                                    | Notes                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| LAN / Gateway bridge (recommended) | `http://<host-ip>/`                                                                    | Run `.\scripts\kind-gateway\start-gateway.ps1` + `node scripts/lan-bridge.js`; see [access-path.md](./access-path.md) |
| Ingress (with controller)          | `http://<host-ip>/`                                                                    | No port needed                                                                                                        |
| Port-forward                       | `kubectl port-forward svc/web-ui 3001:3000 -n local-agentic-sandbox --address 0.0.0.0` | Then `http://<host-ip>:3001`                                                                                          |
| NodePort direct                    | `http://<host-ip>:30300`                                                               | Unreliable on Docker Desktop                                                                                          |

For persistent phone access without manual port-forward, create a Windows
Scheduled Task that runs the port-forward command at logon.

## Fresh install

```bash
# 1. Apply namespaces, services, PVCs, deployments, and host service endpoints
#    (strata-service and host-runner-service are part of the kustomization set)
kubectl apply -k deploy/k8s

# 2. Create required Kubernetes Secrets (e.g. sandbox-mcp, sandbox-host-runner, sandbox-llm-supervisor)

# 3. Build all three images (mcp-server, browser-mcp, web-ui), import into containerd, and roll out
node scripts/deploy-cluster.js all
```

> **Note on `make k8s-deploy` and Helm:** `node scripts/deploy-cluster.js` is the canonical local Kubernetes deploy path (it imports images into `desktop-control-plane` containerd storage). The former Helm chart in `deploy/helm/` was removed: it was stale relative to the kustomize manifests (no `pvc-workspace` mount, no `strata-service`/`host-runner-service` endpoints) and had no deploy consumer. `deploy/k8s/kustomization.yaml` is the single installable manifest set.

## Troubleshooting

| Symptom                                  | Cause                                         | Fix                                                    |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `Strata / host-bridge unreachable`       | Host service not running or bound to loopback | Start Strata (`:8080`) / host-bridge (`:8765`) on host |
| Tasks stuck at 25%, milestones `pending` | Old image (pre-fix)                           | `make k8s-deploy` to rebuild                           |
| `kubectl` connection refused             | Docker Desktop not running                    | Start Docker Desktop, wait for whale icon              |
| UI not loading after deploy              | Port-forward died                             | Restart port-forward                                   |
| `make` not recognized (Windows)          | No make on Windows                            | Use manual docker/kubectl commands above               |
