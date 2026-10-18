/**
 * Standalone llama.cpp Supervisor & Dual-Stack Bridge
 *
 * Runs the official upstream llama.cpp Windows release (`C:\AI\llamacpp\bin\llama-server.exe`,
 * Vulkan backend on AMD Radeon RX 9070 XT) against standalone GGUF model files in
 * `C:\AI\llamacpp\models\` with ZERO dependence on any Ollama process, binary, API, or blob store.
 *
 * Also binds a dual-stack IPv6/IPv4 bridge on `'::'` port 11434 (forwarding to 127.0.0.1:11435)
 * because Docker Desktop on Windows forwards `host.docker.internal` container connections over
 * IPv6 loopback (`[::1]`), and logs every proxied request to `logs/llamacpp-standalone.log`.
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
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

  const binaryPath = options.binaryPath || DEFAULT_BINARY_PATH;
  const args = buildLlamaServerArgs(options);
  const env = buildLlamaServerEnv(process.env, { binaryPath });

  let childProc = null;
  let shuttingDown = false;

  const spawnServer = () => {
    if (shuttingDown) return;
    stopAnyOllamaProcesses(() => {});
    writeLog(`[llama-standalone] Spawning official standalone llama-server: ${binaryPath} ${args.join(" ")}`);
    childProc = spawn(binaryPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

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
      if (!shuttingDown) {
        setTimeout(spawnServer, 2000);
      }
    });
  };

  spawnServer();

  // Dual-stack IPv6 + IPv4 bridge on port 11434 -> 127.0.0.1:11435
  const bridgePort = options.bridgePort || DEFAULT_BRIDGE_PORT;
  const backendPort = options.port || DEFAULT_BACKEND_PORT;

  const server = net.createServer((clientSocket) => {
    let loggedHeader = false;
    const upstream = net.connect({ host: "127.0.0.1", port: backendPort });

    clientSocket.on("data", (chunk) => {
      if (!loggedHeader) {
        loggedHeader = true;
        const firstLine = chunk.toString("utf8", 0, Math.min(chunk.length, 160)).split("\r\n")[0];
        writeLog(`[llama-standalone :${bridgePort}] ${clientSocket.remoteAddress} -> ${firstLine}`);
      }
      upstream.write(chunk);
    });

    upstream.on("data", (chunk) => {
      clientSocket.write(chunk);
    });

    clientSocket.on("end", () => upstream.end());
    upstream.on("end", () => clientSocket.end());

    clientSocket.on("error", () => upstream.destroy());
    upstream.on("error", () => clientSocket.destroy());
  });

  server.listen({ port: bridgePort, host: "::", ipv6Only: false }, () => {
    writeLog(
      `[llama-standalone] Dual-stack IPv6/IPv4 bridge listening on [::]:${bridgePort} -> 127.0.0.1:${backendPort}`
    );
  });

  const cleanup = () => {
    shuttingDown = true;
    try {
      server.close();
    } catch {
      // ignore
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
}

module.exports = {
  DEFAULT_BINARY_PATH,
  DEFAULT_MODEL_PATH,
  DEFAULT_MMPROJ_PATH,
  DEFAULT_MODEL_ALIAS,
  DEFAULT_BACKEND_PORT,
  DEFAULT_BRIDGE_PORT,
  buildLlamaServerArgs,
  buildLlamaServerEnv,
  stopAnyOllamaProcesses,
  startStandaloneSupervisor
};

if (require.main === module) {
  startStandaloneSupervisor();
}
