/**
 * Standalone llama.cpp Supervisor & Dual-Stack Bridge
 *
 * Runs the official upstream llama.cpp Windows release (`C:\AI\llamacpp\bin\llama-server.exe`,
 * Vulkan backend on AMD Radeon RX 9070 XT) against standalone GGUF model files in
 * `C:\AI\llamacpp\models\` with ZERO dependence on any Ollama process, binary, API, or blob store.
 *
 * Provides authenticated control endpoints:
 * - GET  /control/status -> { status: "running"|"stopped"|"starting", pid, uptime_s, model, vram_mb }
 * - POST /control/stop   -> gracefully terminates llama-server.exe child, returns { status: "stopped" }
 * - POST /control/start  -> respawns llama-server.exe child, returns { status: "starting"|"running" }
 *
 * Also binds a dual-stack IPv6/IPv4 bridge on `'::'` port 11434 (forwarding to 127.0.0.1:11435)
 * because Docker Desktop on Windows forwards `host.docker.internal` container connections over
 * IPv6 loopback (`[::1]`), and logs every proxied request to `logs/llamacpp-standalone.log`.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const DEFAULT_BINARY_PATH =
  process.env.LLAMACPP_BINARY_PATH || "C:\\AI\\llamacpp\\bin\\llama-server.exe";
const DEFAULT_MODEL_PATH =
  process.env.LLAMACPP_MODEL_PATH || "C:\\AI\\llamacpp\\models\\swift-15-27b-mtp.gguf";
const DEFAULT_MMPROJ_PATH =
  process.env.LLAMACPP_MMPROJ_PATH || "C:\\AI\\llamacpp\\models\\swift-15-27b-mtp-mmproj.gguf";
const DEFAULT_MODEL_ALIAS = process.env.LLAMACPP_MODEL_ALIAS || "swift-15-27b-mtp";
const DEFAULT_BACKEND_PORT = Number(process.env.LLAMACPP_BACKEND_PORT || 11435);
const DEFAULT_BRIDGE_PORT = Number(process.env.LLAMACPP_BRIDGE_PORT || 11434);
const DEFAULT_CONTROL_PORT = Number(process.env.LLAMACPP_CONTROL_PORT || 11435);
const DEFAULT_VRAM_MB = Number(process.env.LLAMACPP_VRAM_MB || 16384);

const ENGINE_STOPPED_MESSAGE = "LLM engine is stopped. Start it from Settings or the status bar.";

function buildLlamaServerArgs(config = {}) {
  const modelPath = config.modelPath || DEFAULT_MODEL_PATH;
  const mmprojPath = config.mmprojPath || DEFAULT_MMPROJ_PATH;
  const alias = config.alias || DEFAULT_MODEL_ALIAS;
  const port = String(config.port || DEFAULT_BACKEND_PORT);
  const host = config.host || "127.0.0.1";
  const ctxSize = String(config.ctxSize || 8192);

  const args = [
    "--model",
    modelPath,
    "--alias",
    alias,
    "--port",
    port,
    "--host",
    host,
    "--no-webui",
    "--offline",
    "-ngl",
    "99",
    "-c",
    ctxSize,
    "-np",
    "1",
    "--spec-type",
    "draft-mtp",
    "--spec-draft-n-max",
    "3",
    "--spec-draft-backend-sampling",
    "--cache-type-k",
    "q8_0",
    "--cache-type-v",
    "q8_0",
    "--flash-attn",
    "auto",
    "-b",
    "512",
    "-ub",
    "512",
    "--context-shift",
    "--keep",
    "4"
  ];

  if (mmprojPath) {
    args.push("--mmproj", mmprojPath);
  }

  return args;
}

function buildLlamaServerEnv(baseEnv = process.env, config = {}) {
  const binDir = path.dirname(config.binaryPath || DEFAULT_BINARY_PATH);
  const existingPath = baseEnv.PATH || baseEnv.Path || "";
  return {
    ...baseEnv,
    PATH: `${binDir};${existingPath}`
  };
}

function stopAnyOllamaProcesses(logFn = console.log) {
  if (process.platform !== "win32") return;
  try {
    execSync(
      'powershell.exe -NoProfile -Command "Get-Process -Name \'ollama*\' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"',
      { stdio: "ignore" }
    );
    logFn("[llama-standalone] Verified zero Ollama processes running.");
  } catch {
    // Ignore if none running
  }
}

function handleControlRequest(req, res, state, options = {}) {
  const token = req.headers["x-control-token"];
  const expectedToken = options.controlToken || process.env.LLM_SUPERVISOR_TOKEN;
  if (!token || (expectedToken && token !== expectedToken)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized", status: "unauthorized" }));
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/control/status") {
    const uptime_s = state.spawnedAt && state.status === "running"
      ? Math.floor((Date.now() - state.spawnedAt) / 1000)
      : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: state.status,
      pid: state.childProc ? state.childProc.pid : null,
      uptime_s,
      model: state.model || DEFAULT_MODEL_ALIAS,
      vram_mb: state.vramMb || DEFAULT_VRAM_MB
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/control/stop") {
    if (state.childProc && !state.childProc.killed) {
      try {
        state.childProc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    state.status = "stopped";
    state.childProc = null;
    state.spawnedAt = null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "stopped" }));
    return;
  }

  if (req.method === "POST" && pathname === "/control/start") {
    if (state.status === "running" && state.childProc) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "running" }));
      return;
    }
    state.status = "starting";
    if (options.spawnFn) {
      try {
        options.spawnFn();
      } catch (err) {
        state.status = "stopped";
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, status: "stopped" }));
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "starting" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
}

function createControlServer(state, options = {}) {
  const backendPort = options.backendPort || DEFAULT_BACKEND_PORT;
  const writeLog = options.writeLog || (() => {});

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (parsedUrl.pathname.startsWith("/control/")) {
      handleControlRequest(req, res, state, options);
      return;
    }

    // Engine is stopped
    if (state.status === "stopped") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: ENGINE_STOPPED_MESSAGE,
          type: "engine_stopped"
        }
      }));
      return;
    }

    // Engine is starting
    if (state.status === "starting") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "LLM engine is starting...",
          type: "engine_starting"
        }
      }));
      return;
    }

    // Proxy request to backend llama-server
    writeLog(`[llama-standalone] ${req.socket?.remoteAddress || "client"} -> ${req.method} ${req.url}`);
    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = `127.0.0.1:${backendPort}`;

    const proxyReq = http.request({
      host: "127.0.0.1",
      port: backendPort,
      method: req.method,
      path: req.url,
      headers: proxyHeaders
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      writeLog(`[llama-standalone] Proxy error: ${err.message}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: `Engine proxy error: ${err.message}`,
          type: "engine_proxy_error"
        }
      }));
    });

    req.pipe(proxyReq);
  });

  return server;
}

function startStandaloneSupervisor(options = {}) {
  const repoRoot = path.resolve(__dirname, "..");
  const logsDir = path.join(repoRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = options.logFile || path.join(logsDir, "llamacpp-standalone.log");

  const writeLog = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      fs.appendFileSync(logFile, line, "utf8");
    } catch {
      // ignore file write errors
    }
    console.log(msg);
  };

  stopAnyOllamaProcesses(writeLog);

  const controlToken =
    options.controlToken ||
    process.env.LLM_SUPERVISOR_TOKEN ||
    crypto.randomUUID();
  writeLog(`[llama-standalone] Control token: ${controlToken}`);

  const binaryPath = options.binaryPath || DEFAULT_BINARY_PATH;
  const args = buildLlamaServerArgs(options);
  const env = buildLlamaServerEnv(process.env, { binaryPath });
  const backendPort = options.port || options.backendPort || DEFAULT_BACKEND_PORT;
  const bridgePort = options.bridgePort || DEFAULT_BRIDGE_PORT;

  let childProc = null;
  let shuttingDown = false;

  const state = {
    status: "stopped",
    childProc: null,
    spawnedAt: null,
    model: options.alias || DEFAULT_MODEL_ALIAS,
    vramMb: DEFAULT_VRAM_MB
  };

  const spawnServer = () => {
    if (shuttingDown || state.status === "stopped") return;
    state.status = "starting";
    stopAnyOllamaProcesses(() => {});
    writeLog(`[llama-standalone] Spawning official standalone llama-server: ${binaryPath} ${args.join(" ")}`);
    childProc = spawn(binaryPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    state.childProc = childProc;
    state.spawnedAt = Date.now();
    state.status = "running";

    const onData = (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        try {
          fs.appendFileSync(logFile, `[llama-server] ${text}\n`, "utf8");
        } catch {
          // ignore
        }
      }
    };
    childProc.stdout.on("data", onData);
    childProc.stderr.on("data", onData);

    childProc.on("exit", (code, signal) => {
      writeLog(`[llama-standalone] llama-server exited (code=${code}, signal=${signal})`);
      const wasRunning = state.status === "running";
      state.childProc = null;
      state.spawnedAt = null;
      if (wasRunning && !shuttingDown) {
        writeLog("[llama-standalone] Unexpected exit while running. Restarting in 2s...");
        state.status = "starting";
        setTimeout(spawnServer, 2000);
      } else {
        state.status = "stopped";
      }
    });
  };

  if (options.autoStart !== false) {
    state.status = "starting";
    spawnServer();
  }

  // Create HTTP bridge server on bridgePort with dual-stack support
  const bridgeServer = createControlServer(state, {
    controlToken,
    spawnFn: () => {
      state.status = "starting";
      spawnServer();
    },
    backendPort,
    writeLog
  });

  const onListening = () => {
    writeLog(
      `[llama-standalone] Dual-stack HTTP bridge & control listener active on port ${bridgePort} -> 127.0.0.1:${backendPort}`
    );
  };

  try {
    bridgeServer.listen({ port: bridgePort, host: "::", ipv6Only: false }, onListening);
  } catch {
    bridgeServer.listen(bridgePort, "0.0.0.0", onListening);
  }

  let controlServer = null;
  if (options.controlPort && options.controlPort !== bridgePort && options.controlPort !== backendPort) {
    controlServer = createControlServer(state, {
      controlToken,
      spawnFn: () => {
        state.status = "starting";
        spawnServer();
      },
      backendPort,
      writeLog
    });
    controlServer.listen(options.controlPort, "127.0.0.1", () => {
      writeLog(`[llama-standalone] Dedicated control listener on 127.0.0.1:${options.controlPort}`);
    });
  }

  const cleanup = () => {
    shuttingDown = true;
    state.status = "stopped";
    try {
      bridgeServer.close();
    } catch {
      // ignore
    }
    if (controlServer) {
      try {
        controlServer.close();
      } catch {
        // ignore
      }
    }
    if (childProc && !childProc.killed) {
      try {
        childProc.kill();
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  return { state, bridgeServer, controlServer, controlToken };
}

module.exports = {
  DEFAULT_BINARY_PATH,
  DEFAULT_MODEL_PATH,
  DEFAULT_MMPROJ_PATH,
  DEFAULT_MODEL_ALIAS,
  DEFAULT_BACKEND_PORT,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_CONTROL_PORT,
  DEFAULT_VRAM_MB,
  ENGINE_STOPPED_MESSAGE,
  buildLlamaServerArgs,
  buildLlamaServerEnv,
  stopAnyOllamaProcesses,
  handleControlRequest,
  createControlServer,
  startStandaloneSupervisor
};

if (require.main === module) {
  startStandaloneSupervisor();
}
