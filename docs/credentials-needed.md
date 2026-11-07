# Sandbox Credential & Egress Configuration Requirements

## Context
Build Mode (Overnight Autonomy & Task Execution) runs inside an isolated Kubernetes pod (`web-ui`) within the `local-agentic-sandbox` namespace.
By default, the pod operates in an air-gapped network configuration:
- Network mesh: `ai-mesh`
- Egress policy: `BLOCKED` (`"air_gapped": true`)
- Git Remote: Points to `/workspace/.agent/origin-develop.bundle` (a local, read-only snapshot archive).

## Required Credentials for Remote Git Push & PR Automation
To enable workers to push branches to a remote git forge (e.g. GitHub) and open pull requests:

1. **Authentication Token**:
   - Environment Variable: `GITHUB_TOKEN` or `GH_TOKEN`
   - Scopes required: `repo` (contents: write, pull requests: write)
   - Configuration path: Inject via Kubernetes Secret (`sandbox-git-credentials`) referenced in `deploy/k8s/web-ui.yaml` or container env.

2. **Network Egress Policy**:
   - The cluster NetworkPolicy or service mesh must permit outbound HTTPS (TCP port 443) traffic to `github.com` and `api.github.com`.
   - Alternatively, configure an in-cluster Git Proxy service on the internal service mesh.

## Honesty Enforcement (Zero False Success Rail)
When remote push credentials or egress are absent:
- The worker runtime strictly detects that push is not configured.
- The task terminal status and Morning Report record:
  `completed — local only, push not configured`
  or
  `failed: <push error>`
- The system **never** fabricates a pushed branch or hallucinated PR URL.
