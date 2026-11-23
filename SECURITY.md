# Security Policy

This project is a zero-trust, air-gapped agentic sandbox. It runs local LLMs and
Model Context Protocol servers inside hardened containers, with an outbound
egress mesh and no cloud dependency for inference.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| < 2.0   | :x:                |

Security fixes land on `develop` and are back-ported to the release tag only when
a published tag is affected.

## Reporting a Vulnerability

Report vulnerabilities through **GitHub private vulnerability reporting** on this
repository (Security tab -> "Report a vulnerability"). That channel is encrypted,
private to the repository maintainers, and does not expose the report publicly.

Do **not** open a public issue for anything exploitable. Public issues are for
functional bugs and feature requests only.

What to include in a report:

- The affected component (`web-ui/`, `host-bridge/`, `mcp-server/`, `browser-mcp/`,
  `deploy/helm/`, or a container image tag).
- The attack path: which boundary is crossed (container isolation, egress mesh,
  host-bridge RPC, MCP tool surface, Kubernetes RBAC).
- The exact reproduction steps and the version/commit.
- Whether the issue is reachable from the network or requires local access.

Expect a first response within 3 business days. Reports are triaged against the
same audit gate that governs every merge: no dependency or code change merges
without passing the security boundary verification in CI.

## Threat Model and Caveats

The security boundary is enforced by CI (`ci.yml`, "CI Pipeline & Security Boundary
Verification") and by the container provenance checks. Read these before reporting:

- **Air-gap posture.** Inference runs locally; nothing leaves the machine except
  explicitly permitted egress through the egress mesh. Anything that widens egress
  is a security change, not a convenience change.
- **Container isolation.** `mcp-server` and `browser-mcp` run as non-root inside
  hardened containers. `npm run verify:sec` asserts the runtime identity. A report
  showing privilege escalation inside either container is high severity.
- **LAN bridge caveat.** `npm run lan:bridge` exposes the daemon surface on the
  local network so other devices on the same LAN can reach it. That is a deliberate
  local-network trust boundary, not a public one. Anything that makes that surface
  reachable beyond the LAN, or that removes the localhost-only assumption of the
  engine, is a vulnerability.
- **Host bridge.** The host-runner daemon executes on the host machine. Tool calls
  that reach it are the highest-risk surface in this repository; treat any bypass of
  its approval gate as high severity.
- **Production workload.** The production web-ui deployment must stay available.
  Denial-of-service paths against it are treated as high severity even if they do
  not disclose data.

## Hardening Already in Place

- Non-root container execution with verified provenance.
- Restricted egress mesh; no ambient internet access for inference containers.
- Kubernetes namespace-scoped deployment with explicit RBAC.
- CI security boundary verification on every push and pull request.
- Dependency advisories reviewed by Dependabot on a weekly cadence; every update PR
  still goes through the normal audit and CI gate before merge.
