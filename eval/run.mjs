#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { mode: "endpoint", chunkRounds: 8, jobTimeoutMinutes: 90, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint") args.endpoint = argv[++i];
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--chunk-rounds") args.chunkRounds = Number(argv[++i]);
    else if (a === "--job-timeout-minutes") args.jobTimeoutMinutes = Number(argv[++i]);
    else if (a === "--sandbox-url") args.sandboxUrl = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  return args;
}

async function resolveModel(endpoint, requestedModel) {
  if (requestedModel) return requestedModel;
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/models`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.data) && data.data.length > 0) {
        return data.data[0].id;
      }
    }
  } catch {
    // fall back to default
  }
  return "default";
}

async function callEndpoint(endpoint, model, prompt, taskId) {
  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  if (taskId === "tool-discipline") {
    body.tools = [
      {
        type: "function",
        function: {
          name: "verify_environment",
          description: "Verify the workspace environment.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
  }
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const durationMs = Date.now() - start;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Endpoint ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const msg = json?.choices?.[0]?.message || {};
  return {
    output: msg.content || "",
    toolCalls: msg.tool_calls || [],
    toolCallsExecuted: 0,
    durationMs,
    raw: json,
  };
}

const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "stopped"]);

export async function runJobMode({
  sandboxUrl,
  prompt,
  chunkRounds,
  pollIntervalMs = 15000,
  timeoutMs = 90 * 60 * 1000,
  tracePath,
  taskId,
  fetchImpl = fetch,
}) {
  const baseUrl = (sandboxUrl || "http://127.0.0.1:3000").replace(/\/$/, "");
  const start = Date.now();
  const res = await fetchImpl(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "launchTask",
      goal: prompt,
      chunkBudget: { maxRounds: chunkRounds },
    }),
  });
  if (!res.ok) {
    throw new Error(`Sandbox job submit failed (${res.status}): ${await res.text()}`);
  }
  const submitData = await res.json();
  const threadId = submitData?.thread?.id || submitData?.id;
  if (!threadId) {
    throw new Error(`Sandbox job submit did not return a thread id: ${JSON.stringify(submitData)}`);
  }

  let lastThread = submitData?.thread || submitData;
  const writeFailureTrace = () => {
    if (tracePath) {
      fs.writeFileSync(
        tracePath,
        JSON.stringify({ taskId, prompt, output: "", durationMs: Date.now() - start, raw: lastThread }, null, 2),
        "utf8"
      );
    }
  };

  while (true) {
    if (Date.now() - start >= timeoutMs) {
      writeFailureTrace();
      throw new Error(`Sandbox job ${threadId} timed out after ${timeoutMs}ms (last status: ${lastThread?.status})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollRes = await fetchImpl(`${baseUrl}/api/threads/${threadId}`);
    if (!pollRes.ok) {
      writeFailureTrace();
      throw new Error(`Sandbox job poll failed (${pollRes.status}): ${await pollRes.text()}`);
    }
    const pollData = await pollRes.json();
    lastThread = pollData?.thread || pollData;
    const status = lastThread?.status;
    if (status === "needs_input") {
      writeFailureTrace();
      throw new Error(`Sandbox job ${threadId} stopped with status needs_input`);
    }
    if (TERMINAL_THREAD_STATUSES.has(status)) {
      break;
    }
  }

  const messages = Array.isArray(lastThread?.messages) ? lastThread.messages : [];
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m?.role === "assistant" && typeof m?.content === "string" && m.content.trim().length > 0);
  if (!lastAssistant) {
    writeFailureTrace();
    throw new Error(`Sandbox job ${threadId} finished (${lastThread?.status}) with no assistant message content`);
  }

  return {
    output: lastAssistant.content,
    toolCalls: [],
    toolCallsExecuted: 0,
    durationMs: Date.now() - start,
    raw: lastThread,
  };
}

async function runTask(task, args, runDir) {
  const prompt = fs.readFileSync(path.join(repoRoot, task.promptFile), "utf8");
  const graderMod = await import(pathToFileURL(path.join(repoRoot, task.grader)).href);
  const graderFn = Object.values(graderMod).find((v) => typeof v === "function");

  let trace;
  if (args.mode === "job") {
    trace = await runJobMode({
      sandboxUrl: args.sandboxUrl,
      prompt,
      chunkRounds: args.chunkRounds,
      timeoutMs: (args.jobTimeoutMinutes || 90) * 60 * 1000,
      tracePath: path.join(runDir, `${task.id}.trace.json`),
      taskId: task.id,
    });
  } else {
    const model = await resolveModel(args.endpoint, args.model);
    trace = await callEndpoint(args.endpoint, model, prompt, task.id);
  }

  fs.writeFileSync(
    path.join(runDir, `${task.id}.trace.json`),
    JSON.stringify({ taskId: task.id, prompt, ...trace }, null, 2),
    "utf8"
  );

  const inputForGrader = task.id === "tool-discipline" ? trace : trace.output;
  const grade = await graderFn(inputForGrader, task.passBar, repoRoot);
  return {
    id: task.id,
    title: task.title,
    passed: Boolean(grade.passed),
    durationMs: trace.durationMs,
    evidence: grade.evidence,
  };
}

function formatScorecardMd(scorecard) {
  const lines = [
    `# Eval Scorecard (pack v${scorecard.packVersion})`,
    "",
    `- **Run ID**: \`${scorecard.runId}\``,
    `- **Mode**: \`${scorecard.mode}\``,
    `- **Target**: \`${scorecard.target}\``,
    `- **Passed**: ${scorecard.passedCount}/${scorecard.totalCount}`,
    "",
    "| Task | Verdict | Duration (ms) | Evidence |",
    "| :--- | :--- | ---: | :--- |",
  ];
  for (const r of scorecard.results) {
    const verdict = r.passed ? "PASS" : "FAIL";
    lines.push(`| ${r.id} | **${verdict}** | ${r.durationMs} | \`${JSON.stringify(r.evidence)}\` |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === "endpoint" && !args.endpoint) {
    console.error("Usage: node eval/run.mjs --endpoint <url> [--task <id> | --all]");
    process.exit(2);
  }

  const pack = JSON.parse(fs.readFileSync(path.join(repoRoot, "eval/pack.json"), "utf8"));
  const selected = args.all
    ? pack.tasks
    : pack.tasks.filter((t) => t.id === args.task);

  if (selected.length === 0) {
    console.error("No matching tasks. Specify --all or --task <id>.");
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(repoRoot, "eval/results", runId);
  fs.mkdirSync(runDir, { recursive: true });

  const results = [];
  for (const task of selected) {
    const res = await runTask(task, args, runDir);
    results.push(res);
  }

  const scorecard = {
    packVersion: pack.version,
    runId,
    mode: args.mode,
    target: args.mode === "job" ? (args.sandboxUrl || "http://127.0.0.1:3000") : args.endpoint,
    passedCount: results.filter((r) => r.passed).length,
    totalCount: results.length,
    results,
  };

  fs.writeFileSync(path.join(runDir, "scorecard.json"), JSON.stringify(scorecard, null, 2), "utf8");
  fs.writeFileSync(path.join(runDir, "scorecard.md"), formatScorecardMd(scorecard), "utf8");
  console.log(JSON.stringify(scorecard, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
