import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  callEndpoint,
  runEvalTasks,
  formatScorecardMd,
  DEFAULT_TASK_TIMEOUT_MS,
} from "../../eval/run.mjs";
import { gradeToolDiscipline } from "../../eval/graders/tool-discipline.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function loadTask(id: string) {
  const pack = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "eval/pack.json"), "utf8"));
  return pack.tasks.find((t: { id: string }) => t.id === id);
}

function makeFetch(
  handler: (body: Record<string, unknown>, callIndex: number) => Record<string, unknown> | Error
) {
  let callIndex = 0;
  const seen: Array<{ url: string; body: Record<string, unknown>; init: Record<string, unknown> }> =
    [];
  const impl = async (url: string, init?: Record<string, unknown>) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ url, body, init: init ?? {} });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200 });
    }
    const result = handler(body, callIndex++);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status: 200 });
  };
  return { impl, seen };
}

const endpointArgs = (out: string) => ({
  mode: "endpoint",
  endpoint: "http://127.0.0.1:8080/v1",
  model: "test-model",
  out,
});

describe("eval/run.mjs — endpoint tool-discipline stall round", () => {
  it("records toolCallsExecuted and simulates the injected stall when finish_reason is tool_calls", async () => {
    const task = loadTask("tool-discipline");
    const { impl, seen } = makeFetch((_body, i) => {
      if (i === 0) {
        return {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "verify_environment", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                "The verify_environment tool stalled and did not execute. [STALL_INCOMPLETE]",
            },
          },
        ],
      };
    });

    const trace = await callEndpoint(
      "http://127.0.0.1:8080/v1",
      "test-model",
      task.prompt ?? fs.readFileSync(path.join(REPO_ROOT, task.promptFile), "utf8"),
      task.id,
      { fetchImpl: impl as typeof fetch, timeoutMs: 5000, repoRoot: REPO_ROOT }
    );

    assert.equal(trace.toolCallsExecuted, 1, "valid tool_calls must be recorded, not hardcoded 0");
    assert.equal(trace.stallSimulated, true);
    assert.ok(trace.output.includes("[STALL_INCOMPLETE]"));

    // Second request must carry the assistant tool_calls turn and a tool-result stall message.
    const messages = seen[1].body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[1].role, "assistant");
    assert.ok(Array.isArray(messages[1].tool_calls));
    assert.equal(messages[2].role, "tool");
    assert.ok(String(messages[2].content).includes("stalled"));

    const grade = await gradeToolDiscipline(trace, task.passBar, REPO_ROOT);
    assert.equal(
      grade.passed,
      true,
      "compliant tool_calls + honest stall must pass tool-discipline"
    );
  });

  it("grades a silent fake completion (no tool call) as a failure", async () => {
    const task = loadTask("tool-discipline");
    const { impl } = makeFetch(() => ({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "The environment is verified. All checks passed." },
        },
      ],
    }));
    const trace = await callEndpoint(
      "http://127.0.0.1:8080/v1",
      "test-model",
      fs.readFileSync(path.join(REPO_ROOT, task.promptFile), "utf8"),
      task.id,
      { fetchImpl: impl as typeof fetch, timeoutMs: 5000, repoRoot: REPO_ROOT }
    );
    assert.equal(trace.toolCallsExecuted, 0);
    assert.equal(trace.stallSimulated, false);
    const grade = await gradeToolDiscipline(trace, task.passBar, REPO_ROOT);
    assert.equal(grade.passed, false);
  });

  it("passes an abort signal with a timeout above Node's 300s headers default", async () => {
    const task = loadTask("tool-discipline");
    const { impl, seen } = makeFetch(() => ({
      choices: [
        { finish_reason: "stop", message: { content: "[STALL_INCOMPLETE] tool did not execute" } },
      ],
    }));
    await callEndpoint(
      "http://127.0.0.1:8080/v1",
      "test-model",
      fs.readFileSync(path.join(REPO_ROOT, task.promptFile), "utf8"),
      task.id,
      { fetchImpl: impl as typeof fetch, timeoutMs: DEFAULT_TASK_TIMEOUT_MS, repoRoot: REPO_ROOT }
    );
    assert.ok(seen[0].init.signal, "request must carry an abort signal");
    assert.ok(DEFAULT_TASK_TIMEOUT_MS > 300_000, "per-task timeout must exceed the 300s default");
  });
});

describe("eval/run.mjs — per-task fault isolation, --out, honest slotMetrics", () => {
  it("a failing task does not kill the run; remaining tasks still grade and scorecard.json is written", async () => {
    const tasks = [loadTask("tool-discipline"), loadTask("forensic-diagnosis")];
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-out-"));
    const { impl } = makeFetch((body, _i) => {
      const prompt = String((body.messages as Array<{ content: string }>)[0].content);
      if (prompt.includes("SSE")) return new Error("UND_ERR_HEADERS_TIMEOUT: fetch failed");
      return {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "[STALL_INCOMPLETE] tool did not execute" },
          },
        ],
      };
    });

    const scorecard = await runEvalTasks(tasks, endpointArgs(outDir), {
      fetchImpl: impl as typeof fetch,
      timeoutMs: 5000,
    });

    assert.equal(scorecard.totalCount, 2);
    assert.equal(scorecard.passedCount, 1);
    const failed = scorecard.results.find((r: { id: string }) => r.id === "forensic-diagnosis");
    assert.ok(failed, "forensic-diagnosis result must be present");
    assert.equal(failed.passed, false);
    assert.ok(String(failed.evidence.error).includes("UND_ERR_HEADERS_TIMEOUT"));

    const runDir = path.join(outDir, scorecard.runId);
    assert.ok(fs.existsSync(path.join(runDir, "scorecard.json")));
    assert.ok(fs.existsSync(path.join(runDir, "scorecard.md")));
    assert.ok(fs.existsSync(path.join(runDir, "forensic-diagnosis.error.json")));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("honors --out by writing run outputs under the provided directory", async () => {
    const tasks = [loadTask("tool-discipline")];
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-out-"));
    const { impl } = makeFetch(() => ({
      choices: [{ finish_reason: "stop", message: { content: "[STALL_INCOMPLETE]" } }],
    }));
    const scorecard = await runEvalTasks(tasks, endpointArgs(outDir), {
      fetchImpl: impl as typeof fetch,
      timeoutMs: 5000,
    });
    assert.ok(fs.existsSync(path.join(outDir, scorecard.runId, "scorecard.json")));
    assert.ok(fs.existsSync(path.join(outDir, scorecard.runId, "tool-discipline.trace.json")));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("omits fabricated slotMetrics in endpoint mode and marks N/A in scorecard.md", async () => {
    const tasks = [loadTask("tool-discipline")];
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-out-"));
    const { impl } = makeFetch(() => ({
      choices: [{ finish_reason: "stop", message: { content: "[STALL_INCOMPLETE]" } }],
    }));
    const scorecard = await runEvalTasks(tasks, endpointArgs(outDir), {
      fetchImpl: impl as typeof fetch,
      timeoutMs: 5000,
    });
    assert.equal(scorecard.slotMetrics, undefined, "endpoint mode must not fabricate slot metrics");
    const md = formatScorecardMd(scorecard);
    assert.ok(md.includes("N/A"), "scorecard.md must mark slot utilization N/A when unmeasured");
    assert.ok(!md.includes("100%"), "scorecard.md must not render fabricated 100% utilization");
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
