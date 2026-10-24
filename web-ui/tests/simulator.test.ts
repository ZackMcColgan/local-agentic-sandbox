import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSimulateCommand,
  getScenario,
  SIMULATION_SCENARIOS,
  createSimulatedChatResponse,
  runSimulatedTask,
  SimulationScenarioKey
} from "../lib/simulator/index";

describe("Simulation Mode Engine & Scenarios Suite", () => {
  it("parses /simulate composer commands accurately", () => {
    const fast = parseSimulateCommand("/simulate chat-fast");
    assert.ok(fast);
    assert.strictEqual(fast.isSimulate, true);
    assert.strictEqual(fast.scenarioKey, "chat-fast");
    assert.strictEqual(fast.speed, 10);

    const slow = parseSimulateCommand("/simulate chat-slow");
    assert.ok(slow);
    assert.strictEqual(slow.scenarioKey, "chat-slow");
    assert.strictEqual(slow.speed, 1); // 1x default for human eyeballing

    const customSpeed = parseSimulateCommand("/simulate chat-slow 25");
    assert.ok(customSpeed);
    assert.strictEqual(customSpeed.scenarioKey, "chat-slow");
    assert.strictEqual(customSpeed.speed, 25);

    const build = parseSimulateCommand("/simulate build-run 5");
    assert.ok(build);
    assert.strictEqual(build.scenarioKey, "build-run");
    assert.strictEqual(build.speed, 5);

    const normal = parseSimulateCommand("Just a normal question about TypeScript");
    assert.strictEqual(normal, null);

    const buildPrefix = parseSimulateCommand("/build create a service");
    assert.strictEqual(buildPrefix, null);
  });

  it("all 8 core scenarios are registered with valid deterministic timelines", () => {
    const requiredKeys: SimulationScenarioKey[] = [
      "chat-fast",
      "chat-slow",
      "chat-tools",
      "build-run",
      "build-retry",
      "engine-stop",
      "project-task",
      "backend-down"
    ];

    for (const key of requiredKeys) {
      const scenario = getScenario(key);
      assert.ok(scenario, `Scenario ${key} must exist`);
      assert.ok(scenario.title, `Scenario ${key} must have a title`);
      assert.ok(scenario.description, `Scenario ${key} must have a description`);
      assert.ok(scenario.events.length > 0, `Scenario ${key} must have events`);
      assert.ok(scenario.initialPrompt, `Scenario ${key} must have an initial prompt`);
      assert.ok(scenario.defaultDurationMs > 0, `Scenario ${key} must have defaultDurationMs`);

      // Verify task-based scenarios provide valid initial task manifests
      if (scenario.mode === "build" || key === "project-task") {
        assert.ok(scenario.initialTask, `Build scenario ${key} must provide initialTask`);
        assert.ok(scenario.initialTask.taskId, `initialTask must have a taskId`);
        assert.ok(Array.isArray(scenario.initialTask.milestones), `initialTask must have milestones`);
      }
    }
  });

  it("chat-tools scenario includes simulated command failure and structured fallback", () => {
    const scenario = getScenario("chat-tools")!;
    const traces = scenario.events.filter((e) => e.type === "trace");
    assert.strictEqual(traces.length, 2, "Must contain exactly 2 trace steps");

    // Trace 1: Failed SQLite command
    const failedTrace = traces[0].trace;
    assert.strictEqual(failedTrace.tool, "execute_sandboxed_command");
    assert.strictEqual(failedTrace.result.exitCode, 1);
    assert.ok(failedTrace.result.stderr.includes("unable to open database file"));

    // Trace 2: Workspace fallback
    const fallbackTrace = traces[1].trace;
    assert.strictEqual(fallbackTrace.tool, "workspace_read_file");
    assert.strictEqual(fallbackTrace.result.success, true);
    assert.ok(fallbackTrace.result.content.includes("142"));
  });

  it("build-retry scenario includes critic rejection and iteration 2 approval", () => {
    const scenario = getScenario("build-retry")!;
    const taskUpdates = scenario.events.filter((e) => e.type === "task_update");
    assert.ok(taskUpdates.length >= 2, "Must contain at least 2 task updates");

    const failedUpdate = taskUpdates.find(
      (u) => u.task?.milestones[0].criticVerdict === "FAIL"
    );
    assert.ok(failedUpdate, "Must contain a task update with criticVerdict FAIL");
    assert.ok(failedUpdate.task?.milestones[0].criticCritique?.includes("SyntaxError"));

    const passedUpdate = taskUpdates.find(
      (u) => u.task?.milestones[0].criticVerdict === "PASS"
    );
    assert.ok(passedUpdate, "Must contain a subsequent task update with criticVerdict PASS");
    assert.strictEqual(passedUpdate.task?.milestones[0].builderIterations, 2);
  });

  it("createSimulatedChatResponse yields readable SSE chunks matching backend contracts", async () => {
    const res = await createSimulatedChatResponse("chat-fast", 100);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream; charset=utf-8");

    const reader = res.body?.getReader();
    assert.ok(reader);

    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
    }

    assert.ok(accumulated.includes("data: {\"type\":\"meta\""));
    assert.ok(accumulated.includes("data: {\"type\":\"status\""));
    assert.ok(accumulated.includes("data: {\"type\":\"token\""));
    assert.ok(accumulated.includes("data: {\"type\":\"done\""));
  });

  it("createSimulatedChatResponse honors AbortSignal immediately", async () => {
    const controller = new AbortController();
    const res = await createSimulatedChatResponse("chat-slow", 1, controller.signal);
    const reader = res.body?.getReader();
    assert.ok(reader);

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);

    let chunksRead = 0;
    while (true) {
      const { done } = await reader.read();
      if (done) break;
      chunksRead++;
    }

    // Should have closed quickly with only 1 or 2 chunks instead of reading for 65s
    assert.ok(chunksRead < 5, `Expected stream to abort quickly, but read ${chunksRead} chunks`);
  });

  it("runSimulatedTask emits updates and cancels immediately on abort", async () => {
    const updates: TaskManifest[] = [];
    const controller = new AbortController();

    runSimulatedTask(
      "build-run",
      50, // fast
      {
        onTaskUpdate: (task) => updates.push(task)
      },
      controller.signal
    );

    // Initial task is emitted synchronously
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].taskId, "sim-task-build-run");

    // Wait 100ms for timeline to step forward
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(updates.length > 1, "Should have received subsequent milestone updates");

    // Abort and verify no further updates
    controller.abort();
    const countAtAbort = updates.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(updates.length, countAtAbort);
  });

  it("createSimulatedChatResponse returns 503 for backend-down scenario", async () => {
    const res = await createSimulatedChatResponse("backend-down");
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.ok, false);
    const body = await res.json();
    assert.ok(body.error.includes("503"));
  });
});
