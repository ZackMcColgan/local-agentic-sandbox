import { SimulationScenario } from "./types";
import { TaskManifest } from "../subagents/types";

export const SIMULATION_SCENARIOS: Record<string, SimulationScenario> = {
  "chat-fast": {
    key: "chat-fast",
    title: "Chat Fast",
    description: "Short streamed reply verifying prompt dispatch, status pill, token stream, and completion.",
    mode: "chat",
    defaultDurationMs: 2000,
    initialPrompt: "System status summary",
    events: [
      { timeMs: 0, type: "status", status: "Connecting to model..." },
      { timeMs: 150, type: "meta", model: "Swift-1.5 (Simulation)" },
      { timeMs: 300, type: "status", status: "Generating response..." },
      { timeMs: 500, type: "thought", thought: "Analyzing local system health across all sandboxed components..." },
      { timeMs: 800, type: "token", content: "All systems nominal. " },
      { timeMs: 1200, type: "token", content: "Local LLM inference latency is 24ms per token. " },
      { timeMs: 1600, type: "token", content: "Air-gapped security boundary active and 0 egress leaks detected." },
      {
        timeMs: 2000,
        type: "done",
        content: "All systems nominal. Local LLM inference latency is 24ms per token. Air-gapped security boundary active and 0 egress leaks detected.",
        durationMs: 2000
      }
    ]
  },

  "chat-slow": {
    key: "chat-slow",
    title: "Chat Slow (60s+ stream with mid-stream Stop support)",
    description: "Extended 65-second real-time streaming response designed to test active waiting, stop-button latency, and token rendering.",
    mode: "chat",
    defaultDurationMs: 65000,
    initialPrompt: "Explain enterprise microservices architectural boundaries in deep detail",
    events: [
      { timeMs: 0, type: "status", status: "Connecting to model..." },
      { timeMs: 500, type: "meta", model: "Swift-1.5 (Simulation)" },
      { timeMs: 1500, type: "status", status: "Analyzing prompt complexity and memory bounds..." },
      { timeMs: 3000, type: "thought", thought: "Evaluating architectural decomposition strategies for high-throughput enterprise workloads..." },
      { timeMs: 6000, type: "thought", thought: "Evaluating architectural decomposition strategies for high-throughput enterprise workloads... Considering event-driven messaging, transaction boundaries, and isolation guarantees." },
      { timeMs: 8000, type: "status", status: "Formulating architectural response..." },
      { timeMs: 10000, type: "token", content: "### Enterprise Microservices Architecture: Boundary Isolation\n\n" },
      { timeMs: 13000, type: "token", content: "Enterprise systems require rigorous decoupling between bounded contexts to maintain resilience. " },
      { timeMs: 16000, type: "token", content: "When services share data models or relational tables directly, any change in one service forces synchronous deployments across the enterprise.\n\n" },
      { timeMs: 20000, type: "token", content: "#### 1. Data Sovereignty & Storage Encapsulation\n\n" },
      { timeMs: 24000, type: "token", content: "Each microservice must strictly own its underlying persistence layer. " },
      { timeMs: 28000, type: "token", content: "No foreign service may connect directly to another service's operational database; all cross-boundary state access is performed via well-typed APIs or immutable event contracts.\n\n" },
      { timeMs: 33000, type: "token", content: "#### 2. Event-Driven Asynchronous Communication\n\n" },
      { timeMs: 38000, type: "token", content: "Synchronous REST calls introduce cascading latency chains under load. " },
      { timeMs: 43000, type: "token", content: "By utilizing durable log-based message brokers (e.g. Apache Kafka or RabbitMQ), downstream consumers process domain events asynchronously without impeding the publishing transaction.\n\n" },
      { timeMs: 48000, type: "token", content: "#### 3. Air-Gapped Observability & Telemetry\n\n" },
      { timeMs: 53000, type: "token", content: "In zero-trust, air-gapped environments, distributed trace propagation allows engineers to pinpoint bottleneck spans without external network dependencies. " },
      { timeMs: 58000, type: "token", content: "Every RPC hop injects standardized trace context headers to preserve lineage.\n\n" },
      { timeMs: 62000, type: "token", content: "Architecture verified according to enterprise isolation standards." },
      {
        timeMs: 65000,
        type: "done",
        content: "### Enterprise Microservices Architecture: Boundary Isolation\n\nEnterprise systems require rigorous decoupling between bounded contexts to maintain resilience. When services share data models or relational tables directly, any change in one service forces synchronous deployments across the enterprise.\n\n#### 1. Data Sovereignty & Storage Encapsulation\n\nEach microservice must strictly own its underlying persistence layer. No foreign service may connect directly to another service's operational database; all cross-boundary state access is performed via well-typed APIs or immutable event contracts.\n\n#### 2. Event-Driven Asynchronous Communication\n\nSynchronous REST calls introduce cascading latency chains under load. By utilizing durable log-based message brokers (e.g. Apache Kafka or RabbitMQ), downstream consumers process domain events asynchronously without impeding the publishing transaction.\n\n#### 3. Air-Gapped Observability & Telemetry\n\nIn zero-trust, air-gapped environments, distributed trace propagation allows engineers to pinpoint bottleneck spans without external network dependencies. Every RPC hop injects standardized trace context headers to preserve lineage.\n\nArchitecture verified according to enterprise isolation standards.",
        durationMs: 65000
      }
    ]
  },

  "chat-tools": {
    key: "chat-tools",
    title: "Chat Tools (Shopping Dashboard Incident)",
    description: "Thinking panel, sandboxed tool execution, simulated command failure, and intelligent self-healing fallback.",
    mode: "chat",
    defaultDurationMs: 10000,
    initialPrompt: "Fetch the latest shopping conversion metrics from the analytics store",
    events: [
      { timeMs: 0, type: "status", status: "Connecting to model..." },
      { timeMs: 200, type: "meta", model: "Swift-1.5 (Simulation)" },
      { timeMs: 600, type: "thought", thought: "Need to retrieve current store metrics. I'll execute a sandboxed SQLite command against /data/analytics.db." },
      { timeMs: 1200, type: "status", status: "Executing sandboxed SQLite query..." },
      {
        timeMs: 1800,
        type: "trace",
        trace: {
          tool: "execute_sandboxed_command",
          args: { command: "sqlite3 /data/analytics.db 'SELECT COUNT(*) FROM orders'" },
          result: { exitCode: 1, stderr: "Error: unable to open database file: /data/analytics.db: No such file or directory" },
          durationMs: 412,
          timestamp: "2026-10-23T22:30:00Z",
          tier: "sandbox"
        }
      },
      {
        timeMs: 2600,
        type: "thought",
        thought: "Primary database /data/analytics.db is unmounted in this sandbox tier. Falling back to structured workspace analytics snapshot at fixtures/analytics-fallback.json."
      },
      { timeMs: 3400, type: "status", status: "Falling back to workspace metrics snapshot..." },
      {
        timeMs: 4200,
        type: "trace",
        trace: {
          tool: "workspace_read_file",
          args: { path: "fixtures/analytics-fallback.json" },
          result: { success: true, content: '{"orders": 142, "revenue": "$18,420", "conversionRate": "3.8%"}' },
          durationMs: 185,
          timestamp: "2026-10-23T22:30:03Z",
          tier: "sandbox"
        }
      },
      { timeMs: 5000, type: "status", status: "Formulating response..." },
      { timeMs: 5600, type: "token", content: "I encountered an issue querying the primary database directly (`/data/analytics.db` was not mounted in this sandbox tier).\n\n" },
      { timeMs: 7000, type: "token", content: "I automatically fell back to the local workspace analytics cache snapshot:\n\n" },
      { timeMs: 8200, type: "token", content: "### Verified Store Performance\n- **Total Orders:** 142\n- **Gross Revenue:** $18,420\n- **Conversion Rate:** 3.8%\n\nAll data verified from local cache within air-gapped security boundary." },
      {
        timeMs: 10000,
        type: "done",
        thought: "Primary database /data/analytics.db is unmounted in this sandbox tier. Falling back to structured workspace analytics snapshot at fixtures/analytics-fallback.json.",
        content: "I encountered an issue querying the primary database directly (`/data/analytics.db` was not mounted in this sandbox tier).\n\nI automatically fell back to the local workspace analytics cache snapshot:\n\n### Verified Store Performance\n- **Total Orders:** 142\n- **Gross Revenue:** $18,420\n- **Conversion Rate:** 3.8%\n\nAll data verified from local cache within air-gapped security boundary.",
        durationMs: 10000
      }
    ]
  },

  "build-run": {
    key: "build-run",
    title: "Build Run (Autonomous Milestone Progression)",
    description: "Autonomous engineering run with LiveRunBlock, milestone checklist, real-time journal, and live file diffs.",
    mode: "build",
    defaultDurationMs: 14000,
    initialPrompt: "Build synthetic microservices telemetry pipeline",
    initialTask: {
      taskId: "sim-task-build-run",
      goal: "Build synthetic microservices telemetry pipeline",
      toolchain: "node:22",
      scope: "PROJECT",
      branchName: "feature/synthetic-telemetry",
      status: "active",
      currentMilestoneIndex: 0,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        {
          timestamp: new Date().toISOString(),
          role: "planner",
          message: "Decomposed goal into 3 architectural milestones. SPEC.md generated."
        }
      ],
      milestones: [
        {
          id: "m1",
          title: "Create Prometheus metrics collector module",
          description: "Implement metrics collector with counters and histograms",
          acceptanceCriteria: [{ id: "ac1", assertion: "MetricsCollector exports increment() and observe()" }],
          status: "in_progress",
          builderIterations: 1,
          criticRounds: 0,
          plannedFiles: ["lib/metrics.ts"]
        },
        {
          id: "m2",
          title: "Implement OpenTelemetry span exporter",
          description: "Wire trace spans to local collector",
          acceptanceCriteria: [{ id: "ac2", assertion: "SpanExporter writes JSON spans" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0,
          plannedFiles: ["lib/exporter.ts"]
        },
        {
          id: "m3",
          title: "Add synthetic load generator test suite",
          description: "Verify pipeline under simulated traffic",
          acceptanceCriteria: [{ id: "ac3", assertion: "All unit tests pass with zero errors" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0,
          plannedFiles: ["tests/load.test.ts"]
        }
      ]
    },
    events: [
      {
        timeMs: 3500,
        type: "task_update",
        task: {
          taskId: "sim-task-build-run",
          goal: "Build synthetic microservices telemetry pipeline",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "feature/synthetic-telemetry",
          status: "active",
          currentMilestoneIndex: 1,
          startedAt: new Date(Date.now() - 4000).toISOString(),
          updatedAt: new Date().toISOString(),
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 3500).toISOString(), role: "planner", message: "Decomposed goal into 3 milestones." },
            { timestamp: new Date(Date.now() - 1500).toISOString(), role: "builder", message: "Created Prometheus metrics collector in lib/metrics.ts" },
            { timestamp: new Date().toISOString(), role: "critic", message: "Milestone 1 approved: Syntax verified, all contracts satisfied." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Create Prometheus metrics collector module",
              description: "Implement metrics collector with counters and histograms",
              acceptanceCriteria: [{ id: "ac1", assertion: "MetricsCollector exports increment() and observe()" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              criticScore: 100,
              diffSummary: "+ export class MetricsCollector {\n+   private counters = new Map<string, number>();\n+   increment(name: string) { this.counters.set(name, (this.counters.get(name) || 0) + 1); }\n+ }",
              plannedFiles: ["lib/metrics.ts"]
            },
            {
              id: "m2",
              title: "Implement OpenTelemetry span exporter",
              description: "Wire trace spans to local collector",
              acceptanceCriteria: [{ id: "ac2", assertion: "SpanExporter writes JSON spans" }],
              status: "in_progress",
              builderIterations: 1,
              criticRounds: 0,
              plannedFiles: ["lib/exporter.ts"]
            },
            {
              id: "m3",
              title: "Add synthetic load generator test suite",
              description: "Verify pipeline under simulated traffic",
              acceptanceCriteria: [{ id: "ac3", assertion: "All unit tests pass with zero errors" }],
              status: "pending",
              builderIterations: 0,
              criticRounds: 0,
              plannedFiles: ["tests/load.test.ts"]
            }
          ]
        }
      },
      {
        timeMs: 7500,
        type: "task_update",
        task: {
          taskId: "sim-task-build-run",
          goal: "Build synthetic microservices telemetry pipeline",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "feature/synthetic-telemetry",
          status: "active",
          currentMilestoneIndex: 2,
          startedAt: new Date(Date.now() - 8000).toISOString(),
          updatedAt: new Date().toISOString(),
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 7500).toISOString(), role: "planner", message: "Decomposed goal into 3 milestones." },
            { timestamp: new Date(Date.now() - 5000).toISOString(), role: "critic", message: "Milestone 1 approved." },
            { timestamp: new Date(Date.now() - 2500).toISOString(), role: "builder", message: "Created OpenTelemetry span exporter in lib/exporter.ts" },
            { timestamp: new Date().toISOString(), role: "critic", message: "Milestone 2 approved: Spans correctly formatted." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Create Prometheus metrics collector module",
              description: "Implement metrics collector",
              acceptanceCriteria: [{ id: "ac1", assertion: "MetricsCollector exports increment()" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              diffSummary: "+ export class MetricsCollector { ... }",
              plannedFiles: ["lib/metrics.ts"]
            },
            {
              id: "m2",
              title: "Implement OpenTelemetry span exporter",
              description: "Wire trace spans to local collector",
              acceptanceCriteria: [{ id: "ac2", assertion: "SpanExporter writes JSON spans" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              criticScore: 100,
              diffSummary: "+ export class SpanExporter {\n+   exportSpan(span: any) { return JSON.stringify(span); }\n+ }",
              plannedFiles: ["lib/exporter.ts"]
            },
            {
              id: "m3",
              title: "Add synthetic load generator test suite",
              description: "Verify pipeline under simulated traffic",
              acceptanceCriteria: [{ id: "ac3", assertion: "All unit tests pass with zero errors" }],
              status: "in_progress",
              builderIterations: 1,
              criticRounds: 0,
              plannedFiles: ["tests/load.test.ts"]
            }
          ]
        }
      },
      {
        timeMs: 12000,
        type: "task_update",
        task: {
          taskId: "sim-task-build-run",
          goal: "Build synthetic microservices telemetry pipeline",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "feature/synthetic-telemetry",
          status: "completed",
          currentMilestoneIndex: 2,
          startedAt: new Date(Date.now() - 12000).toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          testSummary: { passed: 12, failed: 0, durationMs: 410 },
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 11000).toISOString(), role: "planner", message: "Decomposed goal into 3 milestones." },
            { timestamp: new Date(Date.now() - 8000).toISOString(), role: "critic", message: "Milestone 1 approved." },
            { timestamp: new Date(Date.now() - 5000).toISOString(), role: "critic", message: "Milestone 2 approved." },
            { timestamp: new Date(Date.now() - 2000).toISOString(), role: "builder", message: "Added test suite in tests/load.test.ts" },
            { timestamp: new Date().toISOString(), role: "critic", message: "All 12 test assertions passed. Score: 100." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Create Prometheus metrics collector module",
              description: "Implement metrics collector",
              acceptanceCriteria: [{ id: "ac1", assertion: "MetricsCollector exports increment()" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              diffSummary: "+ export class MetricsCollector { ... }",
              plannedFiles: ["lib/metrics.ts"]
            },
            {
              id: "m2",
              title: "Implement OpenTelemetry span exporter",
              description: "Wire trace spans to local collector",
              acceptanceCriteria: [{ id: "ac2", assertion: "SpanExporter writes JSON spans" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              diffSummary: "+ export class SpanExporter { ... }",
              plannedFiles: ["lib/exporter.ts"]
            },
            {
              id: "m3",
              title: "Add synthetic load generator test suite",
              description: "Verify pipeline under simulated traffic",
              acceptanceCriteria: [{ id: "ac3", assertion: "All unit tests pass with zero errors" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              criticScore: 100,
              diffSummary: "+ describe('Telemetry load tests', () => {\n+   it('handles 1000 events/sec', () => assert.ok(true));\n+ });",
              plannedFiles: ["tests/load.test.ts"]
            }
          ]
        }
      },
      {
        timeMs: 14000,
        type: "done",
        content: "Engineering task completed successfully. All 3 milestones passed verification: 12 tests passed, 0 failed in 410ms. Changes ready for review.",
        durationMs: 14000
      }
    ]
  },

  "build-retry": {
    key: "build-retry",
    title: "Build Retry (Self-Healing Step Failure & Recovery)",
    description: "Simulates milestone builder failure, critic rejection with critique feedback, and automated self-healing retry on iteration 2.",
    mode: "build",
    defaultDurationMs: 10000,
    initialPrompt: "Implement strict JSON parser with boundary validation",
    initialTask: {
      taskId: "sim-task-build-retry",
      goal: "Implement strict JSON parser with boundary validation",
      toolchain: "node:22",
      scope: "PROJECT",
      branchName: "feature/strict-parser",
      status: "active",
      currentMilestoneIndex: 0,
      startedAt: new Date(Date.now() - 500).toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        { timestamp: new Date().toISOString(), role: "planner", message: "Planning milestone 1: JSON parser module." }
      ],
      milestones: [
        {
          id: "m1",
          title: "Implement JSON parser with syntax boundaries",
          description: "Strict parser rejecting unclosed quotes and comments",
          acceptanceCriteria: [{ id: "ac1", assertion: "Throws on unclosed syntax" }],
          status: "in_progress",
          builderIterations: 1,
          criticRounds: 0,
          plannedFiles: ["lib/parser.ts"]
        }
      ]
    },
    events: [
      {
        timeMs: 3000,
        type: "task_update",
        task: {
          taskId: "sim-task-build-retry",
          goal: "Implement strict JSON parser with boundary validation",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "feature/strict-parser",
          status: "active",
          currentMilestoneIndex: 0,
          startedAt: new Date(Date.now() - 3500).toISOString(),
          updatedAt: new Date().toISOString(),
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 3000).toISOString(), role: "planner", message: "Planning milestone 1." },
            { timestamp: new Date(Date.now() - 1500).toISOString(), role: "builder", message: "Generated initial parser in lib/parser.ts" },
            { timestamp: new Date().toISOString(), role: "critic", message: "Critic Rejected Iteration 1: SyntaxError: Unterminated string literal on line 42." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Implement JSON parser with syntax boundaries",
              description: "Strict parser rejecting unclosed quotes and comments",
              acceptanceCriteria: [{ id: "ac1", assertion: "Throws on unclosed syntax" }],
              status: "in_progress",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "FAIL",
              criticScore: 40,
              criticCritique: "SyntaxError: Unterminated string literal on line 42. Test suite failed with exit code 1.",
              lastError: "Unterminated string literal on line 42",
              plannedFiles: ["lib/parser.ts"]
            }
          ]
        }
      },
      {
        timeMs: 6500,
        type: "task_update",
        task: {
          taskId: "sim-task-build-retry",
          goal: "Implement strict JSON parser with boundary validation",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "feature/strict-parser",
          status: "active",
          currentMilestoneIndex: 0,
          startedAt: new Date(Date.now() - 7000).toISOString(),
          updatedAt: new Date().toISOString(),
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 6500).toISOString(), role: "planner", message: "Planning milestone 1." },
            { timestamp: new Date(Date.now() - 4000).toISOString(), role: "critic", message: "Critic Rejected Iteration 1." },
            { timestamp: new Date().toISOString(), role: "builder", message: "Self-healing retry: Repaired string boundary on line 42 and re-ran tests." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Implement JSON parser with syntax boundaries",
              description: "Strict parser rejecting unclosed quotes and comments",
              acceptanceCriteria: [{ id: "ac1", assertion: "Throws on unclosed syntax" }],
              status: "in_progress",
              builderIterations: 2,
              criticRounds: 1,
              criticVerdict: "FAIL",
              plannedFiles: ["lib/parser.ts"]
            }
          ]
        }
      },
      {
        timeMs: 9000,
        type: "task_update",
        task: {
          taskId: "sim-task-build-retry",
          goal: "Implement strict JSON parser with boundary validation",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "feature/strict-parser",
          status: "completed",
          currentMilestoneIndex: 0,
          startedAt: new Date(Date.now() - 9500).toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          testSummary: { passed: 8, failed: 0, durationMs: 220 },
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 9000).toISOString(), role: "planner", message: "Planning milestone 1." },
            { timestamp: new Date(Date.now() - 6000).toISOString(), role: "critic", message: "Critic Rejected Iteration 1." },
            { timestamp: new Date(Date.now() - 3000).toISOString(), role: "builder", message: "Self-healing retry completed." },
            { timestamp: new Date().toISOString(), role: "critic", message: "Milestone 1 approved on iteration 2: 8 tests passing. Score: 100." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Implement JSON parser with syntax boundaries",
              description: "Strict parser rejecting unclosed quotes and comments",
              acceptanceCriteria: [{ id: "ac1", assertion: "Throws on unclosed syntax" }],
              status: "completed",
              builderIterations: 2,
              criticRounds: 2,
              criticVerdict: "PASS",
              criticScore: 100,
              diffSummary: "+ export function parseStrictJson(raw: string) {\n+   return JSON.parse(raw.trim());\n+ }",
              plannedFiles: ["lib/parser.ts"]
            }
          ]
        }
      },
      {
        timeMs: 10000,
        type: "done",
        content: "Task completed after automated self-healing retry. Iteration 2 passed all 8 tests with zero syntax errors.",
        durationMs: 10000
      }
    ]
  },

  "engine-stop": {
    key: "engine-stop",
    title: "Engine Stop (Mid-Run Service Disconnect & State Recovery)",
    description: "Simulates sudden engine termination mid-stream, abort banner presentation, and clean composer recovery.",
    mode: "chat",
    defaultDurationMs: 6000,
    initialPrompt: "Analyze distributed database replication lag across all regional nodes",
    events: [
      { timeMs: 0, type: "status", status: "Connecting to model..." },
      { timeMs: 300, type: "meta", model: "Swift-1.5 (Simulation)" },
      { timeMs: 800, type: "status", status: "Querying cluster topology..." },
      { timeMs: 1500, type: "token", content: "Evaluating database replication delay across regional nodes...\n\n" },
      { timeMs: 3000, type: "token", content: "- Region us-east-1: 4ms replication lag (in-sync)\n- Region us-west-2: " },
      {
        timeMs: 4500,
        type: "error",
        error: "Local LLM Engine offline: llama-server process terminated abruptly (HTTP 503 Service Unavailable). Model VRAM was unmapped."
      }
    ]
  },

  "project-task": {
    key: "project-task",
    title: "Project Task (Overnight Workflow on Fixture Project)",
    description: "Simulates an overnight project workflow transitioning through queued, running, and review-ready states.",
    mode: "build",
    defaultDurationMs: 12000,
    initialPrompt: "Run overnight security audit on enterprise-core project",
    initialTask: {
      taskId: "sim-task-project-overnight",
      projectId: "proj-sim-1",
      projectName: "enterprise-core",
      projectRoot: "/workspace/projects/enterprise-core",
      goal: "Run overnight security audit on enterprise-core project",
      toolchain: "node:22",
      scope: "PROJECT",
      branchName: "task/proj-sim-1/security-audit",
      status: "queued",
      currentMilestoneIndex: 0,
      startedAt: new Date(Date.now() - 500).toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoints: [],
      ambiguityFlags: [],
      journal: [
        { timestamp: new Date().toISOString(), role: "planner", message: "Task registered in overnight queue. Awaiting execution worker slot." }
      ],
      milestones: [
        {
          id: "m1",
          title: "Audit npm dependencies and verify SBOM signatures",
          description: "Check for known CVEs and expired package signatures",
          acceptanceCriteria: [{ id: "ac1", assertion: "Zero critical CVEs found in package-lock.json" }],
          status: "pending",
          builderIterations: 0,
          criticRounds: 0,
          plannedFiles: ["package-lock.json"]
        }
      ]
    },
    events: [
      {
        timeMs: 3500,
        type: "task_update",
        task: {
          taskId: "sim-task-project-overnight",
          projectId: "proj-sim-1",
          projectName: "enterprise-core",
          projectRoot: "/workspace/projects/enterprise-core",
          goal: "Run overnight security audit on enterprise-core project",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "task/proj-sim-1/security-audit",
          status: "active",
          currentMilestoneIndex: 0,
          startedAt: new Date(Date.now() - 4000).toISOString(),
          updatedAt: new Date().toISOString(),
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 3500).toISOString(), role: "planner", message: "Worker slot allocated. Checking out task branch." },
            { timestamp: new Date().toISOString(), role: "builder", message: "Executing dependency SBOM scan across 44 installed packages." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Audit npm dependencies and verify SBOM signatures",
              description: "Check for known CVEs and expired package signatures",
              acceptanceCriteria: [{ id: "ac1", assertion: "Zero critical CVEs found" }],
              status: "in_progress",
              builderIterations: 1,
              criticRounds: 0,
              plannedFiles: ["package-lock.json"]
            }
          ]
        }
      },
      {
        timeMs: 8000,
        type: "task_update",
        task: {
          taskId: "sim-task-project-overnight",
          projectId: "proj-sim-1",
          projectName: "enterprise-core",
          projectRoot: "/workspace/projects/enterprise-core",
          goal: "Run overnight security audit on enterprise-core project",
          toolchain: "node:22",
          scope: "PROJECT",
          branchName: "task/proj-sim-1/security-audit",
          status: "completed",
          currentMilestoneIndex: 0,
          startedAt: new Date(Date.now() - 8500).toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          reviewUrl: "/projects?id=proj-sim-1&tab=diff",
          testSummary: { passed: 44, failed: 0, durationMs: 512 },
          checkpoints: [],
          ambiguityFlags: [],
          journal: [
            { timestamp: new Date(Date.now() - 8000).toISOString(), role: "planner", message: "Worker slot allocated." },
            { timestamp: new Date(Date.now() - 4500).toISOString(), role: "builder", message: "Scan finished. 44/44 packages signed and clean." },
            { timestamp: new Date().toISOString(), role: "critic", message: "Overnight security audit approved: review ready." }
          ],
          milestones: [
            {
              id: "m1",
              title: "Audit npm dependencies and verify SBOM signatures",
              description: "Check for known CVEs and expired package signatures",
              acceptanceCriteria: [{ id: "ac1", assertion: "Zero critical CVEs found" }],
              status: "completed",
              builderIterations: 1,
              criticRounds: 1,
              criticVerdict: "PASS",
              criticScore: 100,
              diffSummary: "+ // Enterprise Core security audit: Verified 0 vulnerabilities on 2026-10-23",
              plannedFiles: ["package-lock.json"]
            }
          ]
        }
      },
      {
        timeMs: 10000,
        type: "done",
        content: "Overnight project audit completed. Ready for review on branch task/proj-sim-1/security-audit.",
        durationMs: 10000
      }
    ]
  },

  "backend-down": {
    key: "backend-down",
    title: "Backend Down (503 Service Unavailable Surface)",
    description: "Simulates immediate backend unreachable error, error banner rendering, and composer state preservation.",
    mode: "chat",
    defaultDurationMs: 1500,
    initialPrompt: "Check cluster pod metrics",
    events: [
      {
        timeMs: 400,
        type: "error",
        error: "Service Unavailable (HTTP 503): Agent engine is stopped. Please start the local model service in Settings."
      }
    ]
  }
};
