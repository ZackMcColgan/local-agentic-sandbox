# Contributing

This repository is a zero-trust, air-gapped agentic sandbox: a Next.js web UI
(`web-ui/`), a host daemon (`host-bridge/`), and hardened MCP containers
(`mcp-server/`, `browser-mcp/`) deployed through Docker Compose and Kubernetes.

## Getting Set Up

1. Install the pinned Node version. The single source of truth is `.nvmrc`:

   ```bash
   nvm install   # reads .nvmrc
   nvm use
   ```

   `package.json` declares `engines.node` matching the same pin, and CI consumes
   `.nvmrc` directly, so local and CI run the identical patch version.

2. Install dependencies for all workspaces:

   ```bash
   npm ci --workspaces
   ```

3. Development happens on Windows; CI runs on Linux. `.editorconfig` and
   `.gitattributes` normalize line endings to LF so the two environments never
   disagree about file bytes.

## Branch Flow

- Work on a `feature/*` branch. Branch names describe the work, never the tool or
  agent that produced it.
- Open a pull request into `develop`. Never commit to `develop` directly, and never
  merge to `main`.
- Every pull request goes through the normal audit before merge. Nothing merges on
  green tests alone.

## Verification

Run the change-aware gate, not the full suite:

```bash
npm run test:gate
```

The gate scopes test selection to the files you touched plus their dependency
closure. Never run `npm run test` locally: its lifecycle test can tear down the
running stack, including the production deployment. The full suite runs in CI.

Before pushing, also run the same checks CI enforces:

```bash
npm run format:check   # prettier
npm run lint           # eslint, zero warnings allowed
npx tsc --noEmit -p web-ui/tsconfig.json
```

Formatting and lint are enforced by `.prettierrc.json`, `.editorconfig`, and
ESLint with `--max-warnings 0`. The pre-commit hook (`husky` + `lint-staged`)
formats and lints staged files automatically.

## Pull Requests

Use the pull request template at `.github/PULL_REQUEST_TEMPLATE.md`. State the
briefed scope, the gate result, and any assumptions you made while working.

## Reporting Issues

Use the issue templates under `.github/ISSUE_TEMPLATE/` (bug report, feature
request). For anything exploitable, use private vulnerability reporting instead —
see `SECURITY.md`.
