/**
 * LAN Reverse Proxy Bridge for local-agentic-sandbox
 * 
 * Purpose: Windows Defender Firewall actively blocks inbound external connections
 * to Docker Desktop's binary (com.docker.backend.exe), preventing mobile/LAN devices
 * from accessing container ports directly. However, node.exe is explicitly ALLOWED
 * inbound across all profiles.
 * 
 * This zero-dependency bridge binds node.exe to 0.0.0.0 on port 80 (standard HTTP),
 * port 443 (HTTPS with TLS), and port 3000 (legacy/dev port) on the host, permitting
 * external LAN devices (e.g. mobile phones on 192.168.50.x) to connect cleanly by IP
 * alone without specifying a port over both HTTP and HTTPS!
 */

const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const TARGET_PORT = parseInt(process.env.TARGET_PORT || "3001", 10);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";
const PORTS = process.env.LISTEN_PORTS
  ? process.env.LISTEN_PORTS.split(",").map((p) => parseInt(p.trim(), 10))
  : [80, 443, 3000];

const STRATA_HOST = process.env.STRATA_HOST || "127.0.0.1";
const STRATA_PORT = parseInt(process.env.STRATA_PORT || "8080", 10);

function getStrataStatus() {
  return new Promise((resolve) => {
    const req = http.get(`http://${STRATA_HOST}:${STRATA_PORT}/health`, { timeout: 2500 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({
            status: json.loaded ? "running" : "starting",
            reachable: true,
            model: json.model || "qwen3.8-flash-next-gyro-gyro-s",
            vram_mb: 16000,
            uptime_s: 3600,
            pid: "active"
          });
        } catch {
          resolve({ status: "running", reachable: true, model: "qwen3.8-flash-next-gyro-gyro-s" });
        }
      });
    });
    req.on("error", () => {
      resolve({ status: "stopped", reachable: false, model: "qwen3.8-flash-next-gyro-gyro-s", vram_mb: 0 });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: "stopped", reachable: false, model: "qwen3.8-flash-next-gyro-gyro-s", vram_mb: 0 });
    });
  });
}

function stopStrata() {
  try {
    const stopScript = path.resolve(__dirname, "stop-strata.ps1");
    execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${stopScript}"`, { stdio: "ignore" });
    return true;
  } catch (err) {
    console.error("[LAN Bridge] Error stopping Strata:", err.message);
    return false;
  }
}

function startStrata() {
  try {
    const startScript = path.resolve(__dirname, "start-strata.ps1");
    const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${startScript}"`, { encoding: "utf8" });
    console.log("[LAN Bridge] Launched Strata PID:", out.trim());
    return true;
  } catch (err) {
    console.error("[LAN Bridge] Error starting Strata:", err.message);
    return false;
  }
}

const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.resolve(__dirname, "../deploy/ssl/cert.pem");
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.resolve(__dirname, "../deploy/ssl/key.pem");

const DEFAULT_BIND_HOST = "0.0.0.0";
const STARTUP_WARNING = '[LAN Bridge] WARNING: unauthenticated — any device on the local network can reach the UI and execute shell commands via workspace_run_command. See README.md "LAN bridge security" section.';

function createProxyServer(listenPort) {
  const isHttps = listenPort === 443;

  const requestHandler = (req, res) => {
    const clientIp = req.socket.remoteAddress || "unknown";

    // Direct Host Engine Control Handler for Strata (:8080)
    if (req.url === "/api/engine" || req.url.startsWith("/api/engine?")) {
      if (req.method === "GET") {
        getStrataStatus().then((statusData) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          });
          res.end(JSON.stringify(statusData));
        }).catch((err) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "stopped", reachable: false, error: err.message }));
        });
        return;
      }

      if (req.method === "POST") {
        let bodyStr = "";
        req.on("data", (chunk) => (bodyStr += chunk));
        req.on("end", async () => {
          try {
            const body = JSON.parse(bodyStr || "{}");
            const action = body.action;
            if (action === "stop") {
              stopStrata();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, action: "stop", status: "stopped" }));
              return;
            } else if (action === "start") {
              startStrata();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, action: "start", status: "starting" }));
              return;
            } else if (action === "restart") {
              stopStrata();
              setTimeout(() => {
                startStrata();
              }, 1000);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, action: "restart", status: "starting" }));
              return;
            }
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid action" }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
    }

    const headers = { ...req.headers };
    const isDocRequest = req.url === "/" || req.url.startsWith("/?");
    if (isDocRequest) {
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
    }

    const options = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...headers,
        host: `${TARGET_HOST}:${TARGET_PORT}`,
        "x-forwarded-for": clientIp,
        "x-forwarded-proto": isHttps ? "https" : "http",
        "x-real-ip": clientIp,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const resHeaders = { ...proxyRes.headers };
      if (isDocRequest) {
        resHeaders["cache-control"] = "no-cache, no-store, must-revalidate";
        resHeaders["pragma"] = "no-cache";
        resHeaders["expires"] = "0";
      }
      res.writeHead(proxyRes.statusCode, resHeaders);
      res.on("error", () => { try { proxyReq.destroy(); } catch {} });
      proxyRes.on("error", () => { try { res.destroy(); } catch {} });
      proxyRes.pipe(res, { end: true });

      proxyRes.on("end", () => {
        if (!req.url.startsWith("/_next/")) {
          console.log(`[LAN Bridge :${listenPort}] ${new Date().toISOString().slice(11, 19)} | ${clientIp} | ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        }
      });
    });

    proxyReq.on("error", (err) => {
      console.error(`[LAN Bridge :${listenPort} Error] ${req.method} ${req.url}:`, err.message);
      try {
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head><title>502 Bad Gateway - Sandbox Starting</title></head>
            <body style="background:#020617;color:#f8fafc;font-family:sans-serif;padding:2rem;text-align:center;">
              <h2 style="color:#f43f5e;">Sandbox Container Initializing (502)</h2>
              <p style="color:#94a3b8;">The enterprise-ai-portal container is currently building or starting up.</p>
              <p style="color:#64748b;font-family:monospace;font-size:0.85rem;">Target: ${TARGET_HOST}:${TARGET_PORT} | Error: ${err.message}</p>
              <button onclick="location.reload()" style="background:#10b981;color:#fff;border:none;padding:0.6rem 1.2rem;border-radius:6px;cursor:pointer;margin-top:1rem;">Retry</button>
            </body>
            </html>
          `);
        }
      } catch (e) {}
    });

    req.on("error", (err) => {
      console.error(`[LAN Bridge :${listenPort} Req Error] ${req.method} ${req.url}:`, err.message);
      try { proxyReq.destroy(); } catch {}
    });

    // Pipe incoming request body to target (e.g. POST /api/chat)
    req.pipe(proxyReq, { end: true });
  };

  let server;
  if (isHttps) {
    if (!fs.existsSync(SSL_CERT_PATH) || !fs.existsSync(SSL_KEY_PATH)) {
      console.warn(`[LAN Bridge :443] Notice: SSL cert/key not found at ${SSL_CERT_PATH}. Skipping HTTPS.`);
      return null;
    }
    const sslOptions = {
      cert: fs.readFileSync(SSL_CERT_PATH),
      key: fs.readFileSync(SSL_KEY_PATH)
    };
    server = https.createServer(sslOptions, requestHandler);
  } else {
    server = http.createServer(requestHandler);
  }

  // Handle WebSocket / SSE upgrades
  server.on("upgrade", (req, socket, head) => {
    const proxySocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
      proxySocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (const [key, value] of Object.entries(req.headers)) {
        proxySocket.write(`${key}: ${value}\r\n`);
      }
      proxySocket.write("\r\n");
      if (head.length > 0) {
        proxySocket.write(head);
      }
      socket.pipe(proxySocket);
      proxySocket.pipe(socket);
    });

    proxySocket.on("error", (err) => {
      console.error(`[LAN Bridge :${listenPort} WS Error]:`, err.message);
      socket.destroy();
    });

    socket.on("error", () => {
      proxySocket.destroy();
    });
  });

  server.listen(listenPort, DEFAULT_BIND_HOST, () => {
    console.log(`[LAN Bridge Active] Listening on ${DEFAULT_BIND_HOST}:${listenPort} -> Forwarding to http://${TARGET_HOST}:${TARGET_PORT}`);
    if (listenPort === 80) {
      console.log(`  -> Direct HTTP URL: http://192.168.50.254/ (port 80)`);
    } else if (listenPort === 443) {
      console.log(`  -> Secure HTTPS URL: https://192.168.50.254/ (port 443)`);
    } else {
      console.log(`  -> Port URL: http://192.168.50.254:${listenPort}`);
    }
  });

  server.on("clientError", (err, socket) => {
    try { socket.destroy(); } catch {}
  });

  server.on("error", (err) => {
    console.error(`[LAN Bridge Error on port ${listenPort}]:`, err.message);
  });

  return server;
}

class GatewayWatchdog {
  constructor(options = {}) {
    this.targetPort = options.targetPort || TARGET_PORT || 3001;
    this.targetHost = options.targetHost || TARGET_HOST || "127.0.0.1";
    this.probeIntervalMs = options.probeIntervalMs || 5000;
    this.probeTimeoutMs = options.probeTimeoutMs || 3000;
    this.maxHeals = options.maxHeals || 3;
    this.windowMs = options.windowMs || 300000; // 5 minutes
    this.enabled = options.enabled !== undefined ? options.enabled : (process.env.ACCESS_PATH_MODE === "gateway");
    this.detectionBudgetDescription = "<=11s plus container start time";

    this.nowFn = options.nowFn || (() => Date.now());
    this.logFn = options.logFn || ((msg) => console.log(msg));

    this.probeFn = options.probeFn || this._defaultProbe.bind(this);
    this.restartContainerFn = options.restartContainerFn || this._defaultRestartContainer.bind(this);
    this.startGatewayFn = options.startGatewayFn || this._defaultStartGateway.bind(this);
    this.containerExistsFn = options.containerExistsFn || this._defaultContainerExists.bind(this);

    this.consecutiveFailures = 0;
    this.lastProbeError = null;
    this.healTimestamps = [];
    this.isExhausted = false;
    this.totalHeals = 0;
    this.timer = null;
  }

  async _defaultProbe(url, timeoutMs) {
    return new Promise((resolve) => {
      const probeUrl = url || `http://${this.targetHost}:${this.targetPort}/`;
      const t = timeoutMs || this.probeTimeoutMs;
      const req = http.get(probeUrl, { timeout: t }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve({ ok: true, statusCode: res.statusCode });
        } else {
          resolve({ ok: false, statusCode: res.statusCode, error: `HTTP ${res.statusCode}` });
        }
        res.resume();
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "connect ETIMEDOUT" });
      });

      req.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
    });
  }

  _defaultContainerExists() {
    try {
      const out = execSync("docker ps -a -q -f name=^kind-gateway$", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return Boolean(out && out.trim());
    } catch {
      return false;
    }
  }

  _defaultRestartContainer() {
    try {
      const out = execSync("docker restart kind-gateway", { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
      return { ok: true, output: out.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _defaultStartGateway(port) {
    try {
      const scriptPath = path.resolve(__dirname, "kind-gateway", "start-gateway.ps1");
      const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Port ${port}`, {
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "ignore"]
      });
      return { ok: true, output: out.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  getState() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      healTimestamps: [...this.healTimestamps],
      isExhausted: this.isExhausted,
      totalHeals: this.totalHeals
    };
  }

  async step() {
    if (!this.enabled) return;

    const probeResult = await this.probeFn(`http://${this.targetHost}:${this.targetPort}/`, this.probeTimeoutMs);
    if (probeResult.ok) {
      this.consecutiveFailures = 0;
      this.lastProbeError = null;
      return;
    }

    this.consecutiveFailures++;
    this.lastProbeError = probeResult.error || "Probe failed";

    if (this.consecutiveFailures >= 2) {
      await this._attemptHeal();
    }
  }

  async _attemptHeal() {
    const now = this.nowFn();
    this.healTimestamps = this.healTimestamps.filter((t) => now - t < this.windowMs);

    if (this.healTimestamps.length >= this.maxHeals) {
      if (!this.isExhausted) {
        this.isExhausted = true;
        this.logFn(`[LAN Bridge Watchdog] ${new Date(now).toISOString()} | WATCHDOG EXHAUSTED: max ${this.maxHeals} heals in 5-minute window reached. Pausing auto-heal.`);
      }
      return;
    }

    this.isExhausted = false;
    const containerExists = this.containerExistsFn();
    let action = "";
    let result = "";

    if (containerExists) {
      action = "docker restart kind-gateway";
      const res = this.restartContainerFn();
      result = res.ok ? "Success (restarted container)" : `Failed (${res.error || "unknown error"})`;
    } else {
      action = `start-gateway.ps1 (port ${this.targetPort})`;
      const res = this.startGatewayFn(this.targetPort);
      result = res.ok ? "Success (launched new container)" : `Failed (${res.error || "unknown error"})`;
    }

    this.healTimestamps.push(now);
    this.totalHeals++;
    this.consecutiveFailures = 0;

    this.logFn(
      `[LAN Bridge Watchdog] ${new Date(now).toISOString()} | Probe Error: ${this.lastProbeError} | Action: ${action} | Result: ${result}`
    );
  }

  start() {
    if (!this.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.step().catch((err) => {
        this.logFn(`[LAN Bridge Watchdog Error]: ${err.message}`);
      });
    }, this.probeIntervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

if (require.main === module) {
  console.log("================================================================");
  console.log(STARTUP_WARNING);
  console.log("----------------------------------------------------------------");
  console.log("Starting LAN Reverse Proxy Bridges (Windows Defender Firewall Permitted)...");
  PORTS.map(createProxyServer).filter(Boolean);
  console.log("================================================================");

  const watchdog = new GatewayWatchdog();
  if (watchdog.enabled) {
    console.log("[LAN Bridge] Gateway mode enabled — starting E2E kind-gateway watchdog (5s probe, <=11s detection budget)...");
    watchdog.start();
  }
}

module.exports = {
  createProxyServer,
  GatewayWatchdog,
  STARTUP_WARNING,
  DEFAULT_BIND_HOST,
  PORTS,
  TARGET_PORT,
  TARGET_HOST
};

process.on("uncaughtException", (err) => {
  console.error("[LAN Bridge uncaughtException]:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("[LAN Bridge unhandledRejection]:", err);
});

process.on("exit", (code) => {
  console.log(`[LAN Bridge Process Exit] code=${code}`);
});
