/**
 * Hermetic Stub Engine for Playwright Real-Mode E2E Tests.
 *
 * Implements Ollama and llama.cpp HTTP streaming interfaces:
 * - GET  /api/version
 * - GET  /api/tags
 * - GET  /health
 * - GET  /control/status
 * - GET  /v1/models
 * - POST /api/chat
 * - POST /api/generate
 * - POST /v1/chat/completions
 *
 * Control Hooks:
 * - POST /__stub/script   { script: "long-thinking" | "two-round" | "planner-slow" | "planner-fail" | "default" }
 * - POST /__stub/release  Releases any pending blocked promise (e.g. planner-slow or long-thinking)
 * - POST /__stub/reset    Resets state and history
 * - GET  /__stub/status   Returns current state, active script, blocked requests, and history
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.STUB_ENGINE_PORT || process.env.PORT || "11435", 10);

let activeScript = "default";
let requestHistory = [];
let pendingReleases = [];
let stubReleased = false;
let roundCounter = 0;

function log(...args) {
  console.log("[stub-engine]", ...args);
}

function resolveScript(body, headers) {
  const headerScript = headers && (headers["x-stub-script"] || headers["x-script"]);
  if (headerScript) return headerScript;

  // Check prompt or messages for [script:<name>]
  const bodyText = typeof body === "string" ? body : JSON.stringify(body || {});
  const match = bodyText.match(/\[script:([a-zA-Z0-9_-]+)\]/);
  if (match) return match[1];

  return activeScript;
}

function releaseAllPending() {
  log(`Releasing ${pendingReleases.length} blocked hooks`);
  const hooks = pendingReleases.splice(0);
  for (const fn of hooks) {
    try {
      fn();
    } catch (e) {
      log("Error releasing hook:", e);
    }
  }
  return hooks.length;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  log(`${req.method} ${pathname}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Read request body if present
  let rawBody = "";
  for await (const chunk of req) {
    rawBody += chunk;
  }
  let jsonBody = {};
  if (rawBody.trim()) {
    try {
      jsonBody = JSON.parse(rawBody);
    } catch {}
  }

  // --- CONTROL ENDPOINTS ---
  if (pathname === "/__stub/script" && req.method === "POST") {
    activeScript = jsonBody.script || "default";
    stubReleased = false;
    log("Set active script to:", activeScript);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, activeScript }));
    return;
  }

  if (pathname === "/__stub/release" && req.method === "POST") {
    stubReleased = true;
    const releasedCount = releaseAllPending();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, releasedCount }));
    return;
  }

  if (pathname === "/__stub/reset" && req.method === "POST") {
    activeScript = "default";
    requestHistory = [];
    roundCounter = 0;
    releaseAllPending();
    stubReleased = false;

    const candidateThreadDirs = [
      process.env.THREADS_DIR,
      path.resolve(process.cwd(), ".tmp-e2e-threads"),
      path.resolve(__dirname, "../../../.tmp-e2e-threads"),
      path.resolve(__dirname, "../../.tmp-e2e-threads")
    ].filter(Boolean);

    for (const d of candidateThreadDirs) {
      if (fs.existsSync(d)) {
        try {
          const files = fs.readdirSync(d);
          for (const f of files) {
            try {
              fs.rmSync(path.join(d, f), { recursive: true, force: true });
            } catch {}
          }
        } catch {}
      }
    }

    const candidateCheckpointDirs = [
      process.env.AGENT_CHECKPOINT_DIR,
      path.resolve(process.cwd(), ".tmp-e2e-checkpoints"),
      path.resolve(__dirname, "../../../.tmp-e2e-checkpoints"),
      path.resolve(__dirname, "../../.tmp-e2e-checkpoints")
    ].filter(Boolean);

    for (const d of candidateCheckpointDirs) {
      if (fs.existsSync(d)) {
        try {
          const files = fs.readdirSync(d);
          for (const f of files) {
            try {
              fs.rmSync(path.join(d, f), { recursive: true, force: true });
            } catch {}
          }
        } catch {}
      }
    }

    log("Stub state and thread directories reset");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, reset: true }));
    return;
  }

  if (pathname === "/__stub/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      activeScript,
      pendingReleases: pendingReleases.length,
      roundCounter,
      historyCount: requestHistory.length,
      history: requestHistory
    }));
    return;
  }

  // --- HEALTH & ENGINE STATUS ---
  if (pathname === "/control/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      active: true,
      reachable: true,
      model: "swift-15-27b-mtp",
      vram_mb: 16000,
      uptime_s: 3600
    }));
    return;
  }

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", loaded: true, model: "swift-15-27b-mtp" }));
    return;
  }

  if (pathname === "/api/version" || pathname === "/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "0.1.0" }));
    return;
  }

  if (pathname === "/api/tags" || pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      models: [
        { name: "swift-15-27b-mtp", model: "swift-15-27b-mtp" },
        { name: "qwen3.8-flash-next-gyro-gyro-s", model: "qwen3.8-flash-next-gyro-gyro-s" }
      ],
      data: [
        { id: "swift-15-27b-mtp" },
        { id: "qwen3.8-flash-next-gyro-gyro-s" }
      ]
    }));
    return;
  }

  // Record history
  const script = resolveScript(jsonBody, req.headers);
  requestHistory.push({
    method: req.method,
    pathname,
    script,
    timestamp: Date.now()
  });

  // --- POST /api/chat ---
  if (pathname === "/api/chat" || pathname === "/v1/chat/completions") {
    handleChatRequest(req, res, jsonBody, script);
    return;
  }

  // --- POST /api/generate ---
  if (pathname === "/api/generate") {
    handleGenerateRequest(req, res, jsonBody, script);
    return;
  }

  // 404 for unknown endpoints
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
});

async function handleChatRequest(req, res, body, script) {
  log(`handleChatRequest with script: ${script}`);

  // Internal triage call detection in /api/chat:
  const messages = body.messages || [];
  const isTriage = messages.some(
    (m) => typeof m.content === "string" && m.content.includes("Classify this user request into COMPLEXITY")
  );

  if (isTriage) {
    log("Handling internal triage call -> SIMPLE_EXECUTION");
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    const triageResult = {
      message: {
        role: "assistant",
        content: JSON.stringify({ complexity: "SIMPLE_EXECUTION", reasoning: "standard request" })
      },
      done: true
    };
    res.write(JSON.stringify(triageResult) + "\n");
    res.end();
    return;
  }

  // 1. SCRIPT: long-thinking (CHAT-14 repro)
  if (script === "long-thinking") {
    log("Executing long-thinking script");
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    let released = stubReleased;
    let releasePromise = new Promise((resolve) => {
      if (stubReleased) {
        resolve();
      } else {
        pendingReleases.push(() => {
          released = true;
          resolve();
        });
      }
    });

    const thinkingSteps = [
      "Analyzing requirements and architectural constraints...",
      "Evaluating tool availability and potential side effects...",
      "Synthesizing intermediate reasoning steps...",
      "Verifying boundary invariants against system directives...",
      "Preparing final deliverable synthesis..."
    ];

    let step = 0;
    const interval = setInterval(() => {
      if (released || step >= thinkingSteps.length || res.writableEnded || res.destroyed) {
        clearInterval(interval);
        return;
      }
      try {
        const chunk = {
          message: {
            role: "assistant",
            thinking: `[Step ${step + 1}] ${thinkingSteps[step]}\n`
          },
          done: false
        };
        res.write(JSON.stringify(chunk) + "\n");
      } catch {}
      step++;
    }, 200);

    // Wait for either releaseAllPending() or an 8s fallback timer
    const timerPromise = new Promise((resolve) => setTimeout(resolve, 8000));
    await Promise.race([releasePromise, timerPromise]);
    clearInterval(interval);

    if (!res.writableEnded && !res.destroyed) {
      try {
        const contentChunk = {
          message: {
            role: "assistant",
            content: "Deliberation complete. Here is the verified answer."
          },
          done: false
        };
        res.write(JSON.stringify(contentChunk) + "\n");

        const doneChunk = {
          message: { role: "assistant" },
          done: true
        };
        res.write(JSON.stringify(doneChunk) + "\n");
        res.end();
      } catch (err) {
        log("Error writing long-thinking final answer:", err);
      }
    }
    return;
  }

  // 2. SCRIPT: two-round (CHAT-13 repro)
  if (script === "two-round") {
    const hasSteer = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("[Steer from user, mid-turn]")
    );

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    if (!hasSteer && roundCounter === 0) {
      // Round 1
      roundCounter = 1;
      log("two-round: Round 1 emitting thinking + partial content");

      res.write(JSON.stringify({
        message: {
          role: "assistant",
          thinking: "Round 1 Thinking: Assessing user weather request and current meteorological telemetry...\n"
        },
        done: false
      }) + "\n");

      res.write(JSON.stringify({
        message: {
          role: "assistant",
          content: "The weather today is partly cloudy, 68°F. "
        },
        done: false
      }) + "\n");

      let closed = false;
      req.on("close", () => {
        closed = true;
        log("two-round: Round 1 connection closed/aborted");
      });

      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 30000);
        pendingReleases.push(() => {
          clearTimeout(timeout);
          resolve();
        });
        req.on("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (!closed) {
        res.end();
      }
      return;
    } else {
      // Round 2 (Post-steer)
      roundCounter = 2;
      log("two-round: Round 2 emitting redirected response");

      res.write(JSON.stringify({
        message: {
          role: "assistant",
          thinking: "Round 2 Thinking: User requested an SVG diagram. Redirecting generation to produce SVG weather chart...\n"
        },
        done: false
      }) + "\n");

      res.write(JSON.stringify({
        message: {
          role: "assistant",
          content: "Redirected Answer: Here is the SVG diagram you requested with full weather visualization."
        },
        done: false
      }) + "\n");

      res.write(JSON.stringify({
        message: { role: "assistant" },
        done: true
      }) + "\n");
      res.end();
      return;
    }
  }

  // DEFAULT / FALLBACK CHAT RESPONSE
  log("Serving default chat response");
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache"
  });

  res.write(JSON.stringify({
    message: {
      role: "assistant",
      thinking: "Thinking about response in stub engine...\n"
    },
    done: false
  }) + "\n");

  res.write(JSON.stringify({
    message: {
      role: "assistant",
      content: "Hello from stub engine."
    },
    done: false
  }) + "\n");

  res.write(JSON.stringify({
    message: { role: "assistant" },
    done: true
  }) + "\n");
  res.end();
}

async function handleGenerateRequest(req, res, body, script) {
  log(`handleGenerateRequest with script: ${script}`);
  const prompt = typeof body.prompt === "string" ? body.prompt : "";

  // 3. SCRIPT: planner-fail (BUILD-2 throw repro)
  if (script === "planner-fail") {
    log("planner-fail: returning HTTP 500");
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "Planner model capacity exceeded: forced failure for testing"
    }));
    return;
  }

  // 4. SCRIPT: planner-slow (BUILD-2 hang repro)
  if (script === "planner-slow") {
    // Only block the PLANNER call, not subsequent builder or critic calls
    const isPlanner = prompt.includes("milestone") || prompt.includes("Decompose the following") || prompt.includes("expert autonomous engineering planner");

    if (isPlanner) {
      log("planner-slow: blocking planner until release hook triggered");
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache"
      });

      let closed = false;
      req.on("close", () => {
        closed = true;
        log("planner-slow: connection closed by client");
      });

      // Wait until test calls /__stub/release
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 60000);
        pendingReleases.push(() => {
          clearTimeout(timeout);
          log("planner-slow: release hook invoked");
          resolve();
        });
      });

      if (!closed) {
        const planJson = {
          complexity: "PROJECT",
          milestones: [
            {
              id: "M1",
              title: "Build weather service backend",
              description: "Build microservice architecture",
              status: "completed",
              acceptanceCriteria: [
                {
                  id: "AC-1",
                  assertion: "Backend service operational"
                }
              ]
            }
          ]
        };
        const responsePayload = `<think>Decomposing engineering goal into milestones...</think>${JSON.stringify(planJson)}`;
        res.write(JSON.stringify({
          response: responsePayload,
          done: true
        }) + "\n");
        res.end();
      }
      return;
    }
  }

  // DEFAULT / WORKER GENERATE RESPONSES:
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache"
  });

  // A. Critic review call
  if (prompt.includes("Critic") || prompt.includes("review") || prompt.includes("Review the deliverable") || prompt.includes("VERDICT")) {
    log("handleGenerateRequest: serving Critic approval");
    const criticJson = {
      approved: true,
      feedback: [],
      analysis: "Implementation satisfies all contract requirements."
    };
    res.write(JSON.stringify({
      response: `<think>Reviewing implementation...</think>${JSON.stringify(criticJson)}`,
      done: true
    }) + "\n");
    res.end();
    return;
  }

  // B. Builder code generation call
  if (prompt.includes("builder") || prompt.includes("generate the exact, complete, production-grade file content") || prompt.includes("Provide the complete file content")) {
    log("handleGenerateRequest: serving Builder valid TypeScript code");
    const code = "```typescript\nexport const status = \"operational\";\nexport function run() { return true; }\n```";
    res.write(JSON.stringify({
      response: `<think>Writing production implementation...</think>\n${code}`,
      done: true
    }) + "\n");
    res.end();
    return;
  }

  // C. Fallback Planner decomposition call
  log("handleGenerateRequest: serving fallback Planner JSON");
  const defaultPlan = {
    complexity: "PROJECT",
    milestones: [
      {
        id: "M1",
        title: "Standard milestone",
        description: "Standard milestone execution",
        status: "completed",
        acceptanceCriteria: [
          {
            id: "AC-1",
            assertion: "Milestone criteria satisfied"
          }
        ]
      }
    ]
  };

  res.write(JSON.stringify({
    response: `<think>Standard reasoning...</think>${JSON.stringify(defaultPlan)}`,
    done: true
  }) + "\n");
  res.end();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[stub-engine] Listening on http://0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
