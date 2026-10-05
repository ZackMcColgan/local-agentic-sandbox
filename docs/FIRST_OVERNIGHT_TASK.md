# Runbook: First Real Autonomous Overnight Task

This guide walks through configuring, launching, monitoring, and verifying your first real autonomous overnight task in `local-agentic-sandbox`. Follow these instructions end-to-end to ensure reliable unattended execution.

---

## 1. Picking the First Task

For your initial overnight run, choose a task that is **small, self-contained, and machine-verifiable** within a 1 to 2 hour execution window. Avoid massive open-ended refactors or tasks requiring subjective visual design.

### Criteria for a High-Confidence First Task
- **Scoped Deliverables**: Touches 1 to 3 files with well-defined interfaces.
- **Machine-Checkable**: Must include automated unit tests that can execute and exit with code 0.
- **Air-Gapped Feasibility**: Relies solely on pre-installed toolchain dependencies (Node.js 22 LTS, standard libraries, or existing repository dependencies).

### 3 Concrete Example Tasks

1. **JSDoc Signature Audit**:
   > `"Audit all TypeScript export signatures across web-ui/lib/subagents/ and ensure complete JSDoc annotations on every public interface and method."`
   - *Verification*: `npm run build` and `npx tsx --test tests/**/*.test.ts`.

2. **Historical Metrics CSV Report Generator**:
   > `"Implement a standalone CSV report utility under web-ui/lib/reports/csvReport.ts that parses workspace/reports/morning-*.md files and outputs aggregated milestone completion metrics, accompanied by a unit test suite."`
   - *Verification*: `npx tsx --test tests/csvReport.test.ts` passes with code 0.

3. **Autonomous Architecture Diagram Exporter**:
   > `"Create an SVG architecture diagram generator under web-ui/lib/diagram/systemDiagram.ts documenting container networking between web-ui, mcp-server, and Ollama, verified with an automated format validation test."`
   - *Verification*: Valid `.svg` file generated and verified via XML/SVG parser test.

---

## 2. Creating the Schedule

The platform exposes HTTP scheduling endpoints on port `3001` bound to all network interfaces (`0.0.0.0:3001:3000`), allowing control from your local PC or any LAN device.

> **Timezone warning — read this first.** Cron expressions are evaluated in **UTC** (the daemon runs in a UTC container). Convert your local time: 2:00 AM Central Daylight Time = `0 7 * * *`; 2:00 AM Central Standard Time = `0 8 * * *`. A bare `0 2 * * *` fires at 2 AM UTC = 9 PM Central the prior evening.

Find your host machine's LAN IP (e.g. `192.168.1.150` via `ip a` or `ipconfig`) and execute the following `curl` commands.

### Step 2.1: Schedule the Overnight Task (2:00 AM Central Daily)
```bash
curl -X POST http://<PC-LAN-IP>:3001/api/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "cronExpression": "0 7 * * *",
    "taskDescription": "Implement a standalone CSV report utility under web-ui/lib/reports/csvReport.ts that parses workspace/reports/morning-*.md files and outputs aggregated milestone completion metrics, accompanied by a unit test suite."
  }'
```
**Expected Response (HTTP 200)**:
```json
{
  "id": "sched-1728115200000-abc12",
  "nextRun": "2026-10-06T07:00:00.000Z"
}
```

### Step 2.2: Verify Registered Schedules
```bash
curl http://<PC-LAN-IP>:3001/api/schedules
```
**Expected Response (HTTP 200)**:
```json
{
  "schedules": [
    {
      "id": "sched-1728115200000-abc12",
      "cronExpression": "0 7 * * *",
      "taskDescription": "Implement a standalone CSV report utility...",
      "enabled": true,
      "createdAt": "2026-10-05T14:00:00.000Z",
      "nextRun": "2026-10-06T07:00:00.000Z",
      "failureCount": 0
    }
  ]
}
```

### Step 2.3: Dry-Run / Immediate Trigger (Optional)
To verify the pipeline immediately without waiting for 2:00 AM, trigger the schedule manually:
```bash
curl -X POST http://<PC-LAN-IP>:3001/api/schedules/<SCHEDULE_ID>/trigger
```
**Expected Response (HTTP 200)**:
```json
{
  "runId": "task-1728115210000",
  "status": "active"
}
```

---

## 3. Where to Look in the Morning

When you inspect the results the following morning, check these four artifacts in order:

### 1. Health Status Endpoint
Query the read-only daemon health check:
```bash
curl http://<PC-LAN-IP>:3001/api/scheduler/health
```
```json
{
  "status": "healthy",
  "daemon": {
    "active": true,
    "pid": 24,
    "lastTick": "2026-10-06T06:00:00.123Z",
    "stale": false
  },
  "scheduler": {
    "active": false,
    "scheduleId": "sched-1728115200000-abc12",
    "lastHeartbeat": "2026-10-06T02:45:12.456Z"
  },
  "schedules": {
    "total": 1,
    "enabled": 1,
    "nextRun": "2026-10-07T07:00:00.000Z"
  }
}
```

### 2. Morning Report Markdown
File: `workspace/reports/morning-YYYY-MM-DD.md`
- Contains high-level execution summary, milestone breakdown, git commits made, passed/failed test counts, and flagged ambiguities.

### 3. Dedicated Run Log
File: `workspace/logs/run-*.log`
- Contains timestamped step-by-step logs from `executeScheduledRun`, model token streaming milestones, critic evaluations, and test outputs.

### 4. Scheduler Daemon Log
File: `workspace/logs/scheduler-daemon-YYYY-MM-DD.log`
- Contains 60-second tick logs, heartbeat refreshes, daily log rotations, and any caught exceptions.

---

## 4. Recovery & Backoff Behavior

The system includes automated resilience mechanisms so transient hiccups do not require manual intervention:

1. **Stale Heartbeat Crash Recovery**:
   - The daemon records a heartbeat every tick in `workspace/.scheduler-daemon-heartbeat`.
   - On daemon startup, if a heartbeat file exists with `active: true` but `lastTick` is older than **5 minutes**, the daemon logs `[WARN] Stale heartbeat detected` and automatically invokes `checkCrashAndRecover()`.

2. **Exponential Backoff**:
   - If an individual run crashes mid-milestone, the scheduler backs off before retrying:
     - Attempt 1: **1 minute** (60,000 ms)
     - Attempt 2: **2 minutes** (120,000 ms)
     - Attempt 3: **4 minutes** (240,000 ms)
     - Attempt 4: **8 minutes** (480,000 ms)
     - Attempt 5: **30 minutes** (1,800,000 ms)

3. **Auto-Disable Fail-Safe**:
   - If an individual schedule encounters **5 consecutive failures**, it is automatically disabled (`enabled: false`) and flagged for morning human review. This guarantees the autonomous engine will never consume infinite GPU power or loop indefinitely on unresolvable bugs.

---

## 5. How to Pause or Stop

### Pausing or Canceling a Specific Schedule
Cancel a schedule via the REST API:
```bash
curl -X DELETE "http://<PC-LAN-IP>:3001/api/schedules?id=<SCHEDULE_ID>"
```
Or via path parameter:
```bash
curl -X DELETE "http://<PC-LAN-IP>:3001/api/schedules/<SCHEDULE_ID>"
```
Alternatively, edit `workspace/schedules.json` and set `"enabled": false`.

### Stopping the Daemon Container
To pause the unattended daemon entirely while leaving the Web UI and MCP server running:
```bash
docker compose stop scheduler-daemon
```
**Windows note:** the Docker Desktop credential-helper issue breaks `docker compose` over SSH. Run these from an interactive session on the PC (PowerShell or CMD), not over SSH.

To resume the daemon:
```bash
docker compose start scheduler-daemon
```

To stop all sandbox services:
```bash
docker compose down
```

---

## 6. What "Trustworthy" Means

Autonomous development is only useful if its claims are verifiable. `local-agentic-sandbox` adheres to strict proof criteria:

1. **Resolvable Git SHAs**:
   - Every commit SHA recorded in the morning report (`workspace/reports/morning-YYYY-MM-DD.md`) is guaranteed by `getResolvedGitSha()` to be a real git commit.
   - Verify any reported commit with:
     ```bash
     git log <COMMIT_SHA> -1
     ```
   - If a SHA does not exist in `git log`, the run is invalid. The system strictly refuses to fabricate fake SHAs.

2. **Zero Fabricated Test Counts**:
   - Milestone `testsPassed` and `testsFailed` numbers are parsed directly from real TAP / test runner output.
   - The Critic subagent uses a **Ground-Truth Override** gate: if the test suite exits with non-zero exit codes, the milestone is immediately rejected as `needs_fix`, regardless of model narration.

3. **Model Lock Integrity**:
   - All components (Planner, Builder, Critic, Supervisor) run on `swift-27b-mtp`. No legacy or unaligned models are used.
