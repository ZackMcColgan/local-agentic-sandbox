# Coding Standard

This document defines the engineering standard for all new and refactored code in this repository. Automated tooling enforces mechanical style and static safety; the prose rules below cover architectural boundaries that linters cannot verify on their own.

## Automated Tooling & CI Enforcement

Most style and correctness requirements are executable and enforced in CI (`.github/workflows/ci.yml`):

- **Formatting (Prettier 3):** Enforced by the `Lint & Format` CI job. Configuration lives in `.prettierrc.json` and `.editorconfig` (2-space indent, double quotes, semicolons, `es5` trailing commas, 100-character print width, LF line endings).
  - Format locally: `npm run format`
  - Verify formatting: `npm run format:check` (or `npx prettier --check .`)
- **Static Linting (ESLint 9):** Runs alongside Prettier in the `Lint & Format` CI job with zero-warning policy and no suppression baselines.
- **Strict TypeScript:** Enforced by the `Typecheck (full error report)` CI job.
  - Run locally: `npx tsc --noEmit -p web-ui/tsconfig.json`
- **Automated Tests:** Enforced by `Unit Tests & Static Analysis` and the fast local gate.
  - Fast gate: `npm run test:gate`
  - Full unit suite: `npm run test`

Never bypass or weaken these checks. Fix reported issues at the source before opening or updating a pull request.

## Functional Core, Imperative Shell

Business logic lives in small, deterministic pure functions (**Functional Core**). Side effects — disk I/O, network requests, process execution, timers, environment reads — live in thin orchestration layers (**Imperative Shell**) that gather inputs, delegate decisions to pure functions, and execute the returned actions.

### 1. Keep Core Functions Pure

**Rule:** A logic function takes explicit inputs and returns a value without reading or mutating globals, module-level state, the filesystem, the network, the clock, or randomness.

**Why:** Pure functions are deterministic, trivial to test in isolation, and safe to compose without hidden ordering dependencies.

```ts
// Do: explicit inputs, deterministic return value (web-ui/lib/board/flowMonitor.ts)
export function evaluatePrChecks(headSha: string, checks: PrCheckResult[]): PrCheckVerdict {
  for (const check of checks) {
    if (isCheckFailed(check)) {
      return { status: "red", headSha, failingJob: check.name };
    }
  }
  return { status: "green", headSha };
}

// Don't: reach into external state or mutate shared globals inside decision logic
let lastVerdict: PrCheckVerdict | null = null;
export function evaluatePrChecksUnsafe(checks: PrCheckResult[]): void {
  lastVerdict = {
    status: checks.length > 0 ? "green" : "red",
    headSha: process.env.HEAD_SHA ?? "",
  };
}
```

### 2. Push Side Effects to the Edges

**Rule:** Confine I/O, environment lookups, timers, and persistence to thin shell modules (route handlers, stores, supervisor loops, bridge daemons) that call pure functions to decide what to do.

**Why:** Separating decision logic from effect execution prevents test suites from needing live services or brittle filesystem fixtures just to verify branching rules.

```ts
// Do: shell gathers environment / I/O and passes it into a pure check
export function isFlowMonitorStage2Enabled(
  override?: boolean,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  return env.FLOW_MONITOR_STAGE2 === "true";
}

// Don't: interleave network calls and branching policy in one monolithic handler
export async function handlePrCheckUnsafe(prNumber: number): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/org/repo/pulls/${prNumber}`);
  const data = await res.json();
  if (process.env.FLOW_MONITOR_STAGE2 === "true" && data.state === "open") {
    await fetch("https://api.github.com/repos/org/repo/issues", { method: "POST" });
  }
}
```

### 3. Pass Dependencies as Parameters

**Rule:** Inject collaborators — including effectful functions such as dispatchers, pollers, or clocks — as explicit function parameters rather than importing singletons inside logic modules.

**Why:** Parameterized seams make every failure mode and edge case directly testable without monkey-patching module loaders.

```ts
// Do: accept effectful collaborators through an options object (web-ui/lib/board/flowMonitor.ts)
export interface MonitorPrOptions {
  item: FlowMonitorBoardItem;
  stage2Enabled?: boolean;
  pollChecks: (item: FlowMonitorBoardItem) => Promise<PrChecksSnapshot>;
  issueThread: (params: {
    item: FlowMonitorBoardItem;
    brief: string;
  }) => Promise<{ threadId: string }>;
}

// Don't: hard-wire concrete clients inside orchestration logic
import { githubClient } from "./githubClient";
import { threadDispatcher } from "./threadDispatcher";

export async function monitorPrCoupled(item: FlowMonitorBoardItem): Promise<void> {
  const snapshot = await githubClient.fetchChecks(item);
  await threadDispatcher.dispatch(item, snapshot);
}
```

### 4. Avoid New Logic Classes

**Rule:** Write functions and plain data structures; introduce a class only when an external framework contract requires inheritance, keeping the class a thin adapter over functions.

**Why:** Plain functions and typed records avoid hidden mutable instance state (`this`) and make data flow explicit.

```ts
// Do: pure functions operating on typed data
export function isVerdictValidForHead(verdict: PrCheckVerdict, currentHeadSha: string): boolean {
  return verdict.status === "green" && verdict.headSha === currentHeadSha;
}

// Don't: wrap stateless or stateful logic in a custom service class
export class VerdictValidator {
  private currentHeadSha: string;
  constructor(headSha: string) {
    this.currentHeadSha = headSha;
  }
  validate(verdict: PrCheckVerdict): boolean {
    return verdict.status === "green" && verdict.headSha === this.currentHeadSha;
  }
}
```

### 5. Treat Data as Immutable

**Rule:** Do not mutate function arguments; return new objects or arrays. Any bounded cache must live in a single dedicated module with an explicit size cap and functional accessors.

**Why:** Avoiding in-place mutation eliminates aliasing bugs across async boundaries and concurrent workers.

```ts
// Do: return a new array/object without mutating inputs
export function appendCheckResult(
  checks: readonly PrCheckResult[],
  next: PrCheckResult
): PrCheckResult[] {
  return [...checks, next];
}

// Don't: mutate caller-supplied collections in place
export function appendCheckResultUnsafe(checks: PrCheckResult[], next: PrCheckResult): void {
  checks.push(next);
}
```

### 6. Keep Modules Small and Focused

**Rule:** Give each module one clear responsibility. Place new logic in a focused module rather than appending to an existing large file; any file approaching ~600 lines should be split before growing further.

**Why:** Small modules keep diffs localized, reduce merge conflicts, and make code review and unit testing straightforward.

### 7. Test Behavior by Calling Code

**Rule:** Behavioral tests must invoke the exported functions and assert on returned values or observable seam calls. Source-text inspection tests are reserved strictly for repository hygiene guards and structural invariants, and must be labeled as guards.

**Why:** Calling code directly verifies runtime behavior and survives harmless formatting or refactoring changes; regex-scraping source files breaks on formatting and misses logic bugs.

```ts
// Do: call the function with realistic inputs and assert on the result
const verdict = evaluatePrChecks("abc123", [
  { name: "Lint & Format", status: "COMPLETED", conclusion: "FAILURE" },
]);
assert.equal(verdict.status, "red");
assert.equal(verdict.failingJob, "Lint & Format");

// Don't: assert on implementation text in a behavioral test
const source = fs.readFileSync("lib/board/flowMonitor.ts", "utf8");
assert.ok(source.includes('status: "red"'));
```

### 8. Model Errors Explicitly

**Rule:** Represent expected failure states as structured return values or typed errors; never swallow exceptions in empty `catch` blocks.

**Why:** Silent failures hide defects until they surface far from their root cause.

### 9. Use Clear, Direct Naming

**Rule:** Use verbs for functions (`evaluatePrChecks`, `isVerdictValidForHead`) and nouns for data types (`PrCheckVerdict`, `EscalationEvidence`). Avoid opaque abbreviations and internal codenames.

**Why:** Self-describing identifiers reduce the need for explanatory comments and keep public interfaces readable.

## Pull Request Verification Checklist

Before requesting review:

1. `npm run format:check` passes with zero unformatted files.
2. `npx tsc --noEmit -p web-ui/tsconfig.json` exits `0`.
3. `npm run test:gate` passes within budget.
4. `npm run test` passes across all workspaces.
5. `git status` is clean and the branch contains only intentional commits.
