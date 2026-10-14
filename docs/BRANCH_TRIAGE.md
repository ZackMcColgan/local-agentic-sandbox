# Branch Triage & Audit Matrix

This document records the status, head SHA, merge status relative to `develop` (`2562825`), and architectural fate of all local and remote branches in `ZackMcColgan/local-agentic-sandbox` prior to merging `develop` to `main`.

---

## Branch Status Matrix

| Branch Name | Head SHA | Merged into `develop`? | Fate | Notes |
| :--- | :--- | :---: | :--- | :--- |
| **`develop`** | `2562825` | **Target** | **Active (Sprint 4/5 Integration)** | Primary integration branch. Merge target for all work. |
| **`main`** | `5ac4b29` | Base | **Active (Production Release)** | Protected branch. Never touched directly. |
| `feat/chat-polish` | `09b9fdd` | Yes | **Deleted (Merged)** | Merged into develop (Sprint 2 reading typography, theme consistency). Local deleted. |
| `feat/dogfood-v2` | `225cb9c` | Yes | **Deleted (Merged)** | Merged into develop (Sprint 4 dogfood run drawio toolchain). Local deleted. |
| `feat/fix-docker-build` | `0f0d525` | Yes | **Deleted (Merged)** | Merged into develop. Local deleted. |
| `feat/m3-drawer-ui` | `20f20e4` | Yes | **Deleted (Merged)** | Merged into develop (M3 navigation drawer & sessions list). Local deleted. |
| `feat/phase1-python-ast-fix` | `07bb8dd` | Yes | **Deleted (Merged)** | Merged into develop (MCP TypeScript dependencies & AST validation). Local deleted. |
| `feat/phase2` | `76b1a9a` | Yes | **Deleted (Merged)** | Merged into develop via PR #5. Local deleted. |
| `feat/sessions-fix` | `9d6c401` | Yes | **Deleted (Merged)** | Merged into develop (Sprint 1 session list integrity). Local deleted. |
| `feat/task-controls` | `2b1c0fb` | Yes | **Deleted (Merged)** | Merged into develop (Sprint 3 long-running task controls). Local deleted. |
| `feat/unified-ui` | `147bfec` | Yes | **Deleted (Merged)** | Merged into develop (Unified M3 UI). Local deleted. |
| `feat/v2-autonomous-platform` | `0a50248` | Yes | **Deleted (Merged)** | Merged into develop (Platform hardening batch). Local deleted. |
| `feat/v2.5-overnight` | `ec2bce6` | Yes | **Deleted (Merged)** | Merged into develop (Oracle retrieval & builder). Local deleted. |
| `feat/v2.6-memory` | `af06ccf` | Yes | **Deleted (Merged)** | Merged into develop (Specialized worker Modelfiles). Local deleted. |
| `feature/ci-coverage-report` | `540e648` | Yes | **Deleted (Merged)** | Merged into develop (Gitkeep files & Vitest path alias). Local deleted. |
| `feature/e2e-execution-stall` | `7f8ba1c` | Yes | **Deleted (Merged)** | Merged into develop (Trailing stream buffer drain). Local deleted. |
| `feature/flywheel-spike` | `e47fe47` | Yes | **Deleted (Merged)** | Merged into develop via PR #25. Local deleted. |
| `feature/model-swap-swift-1.5` | `a8fbda0` | Yes | **Deleted (Merged)** | Merged into develop via PR #28. Local deleted. |
| `feature/morning-report-loop` | `3f0e058` | Yes | **Deleted (Merged)** | Merged into develop via PR #21. Local deleted. |
| `feature/run-ledger` | `cb6e3c8` | Yes | **Deleted (Merged)** | Merged into develop via PR #22. Local deleted. |
| `feature/self-deploy` | `a24b9ba` | Yes | **Deleted (Merged)** | Merged into develop via PR #27. Local deleted. |
| `feature/sprint2-ui` | `7c44c32` | Yes | **Deleted (Merged)** | Merged into develop (Behavioral scroll tests & nav dock). Local deleted. |
| `feature/svg-e2e-execfilesync-fix` | `da2d9d8` | Yes | **Deleted (Merged)** | Merged into develop (Git installed in web-ui container). Local deleted. |
| `feature/ux-polish-run` | `919debd` | Yes | **Deleted (Merged)** | Merged into develop (CodeBlock scroll & toggle). Local deleted. |
| `feature/worker-ci-feedback` | `aae3ed3` | Yes | **Deleted (Merged)** | Merged into develop via PR #26. Local deleted. |
| `feature/worker-git-ops` | `1eea607` | Yes | **Deleted (Merged)** | Merged into develop via PR #24. Local deleted. |
| `feature/task-scope-selector` | `62b5b05` | No (Superseded) | **Archived** | Local branch superseded by Sprint 12 verified scope forwarding in PR #28 + develop commit `2562825`. |
| `origin/feat/ci-develop-triggers` | `9a75386` | Yes | **Archived (Remote)** | Merged into develop via PR #7. |
| `origin/feat/phase1-guardrails` | `5edea59` | Yes | **Archived (Remote)** | Merged into develop (Deterministic guardrails). |
| `origin/feat/phase3` | `8953f8c` | Yes | **Archived (Remote)** | Merged into develop (Scheduler update). |
| `origin/feat/phase4` | `4a83f9f` | Yes | **Archived (Remote)** | Merged into develop (Health endpoint & runbook). |
| `origin/feature/ci-triggers-develop` | `9a75386` | Yes | **Archived (Remote)** | Merged into develop. |
| `origin/feature/code-review-fixes` | `3296b6b` | Yes | **Archived (Remote)** | Merged into develop (Critic behavioral test). |
| `origin/feature/fail-closed-step-executor` | `2a848b3` | Yes | **Archived (Remote)** | Merged into develop via PR #9. |
| `origin/feature/k8s-deployment-docs` | `543b43b` | Yes | **Archived (Remote)** | Merged into develop (Kubernetes deployment guide). |
| `origin/feature/k8s-ingress-nginx` | `2bb2767` | No (Superseded) | **Archived (Remote)** | Standalone Ingress spike; superseded by cluster deployment on LAN IP `192.168.50.254:3001` / NodePort `:80`. |
| `origin/feature/k8s-ingress-web-ui` | `a906735` | No (Superseded) | **Archived (Remote)** | Standalone web-ui Ingress manifest; superseded by `deploy/k8s/web-ui.yaml`. |
| `origin/feature/makefile-k8s-deploy` | `b8f8f5c` | No (Superseded) | **Archived (Remote)** | Superseded by root `Makefile` targets in `develop`. |
| `origin/feature/threads-fixes-v2` | `de8e495` | No (Superseded) | **Archived (Remote)** | Historical PR branch superseded by landed thread store fixes. |
| `origin/feature/threads-fixes-v3` | `106cd26` | No (Superseded) | **Archived (Remote)** | Historical PR branch superseded by landed thread store fixes. |
| `origin/feature/threads-launch-executes-task` | `d179d50` | No (Superseded) | **Archived (Remote)** | Historical PR branch superseded by landed thread store & swipe fix. |

---

## Summary
- **Local merged feature branches:** Cleaned up and deleted (24 local branches deleted).
- **develop:** Ready for final review and squash/fast-forward merge to `main`.
