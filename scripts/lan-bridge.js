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

const TARGET_PORT = parseInt(process.env.TARGET_PORT || "3001", 10);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";
const PORTS = process.env.LISTEN_PORTS
  ? process.env.LISTEN_PORTS.split(",").map((p) => parseInt(p.trim(), 10))
  : [80, 443, 3000];

const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.resolve(__dirname, "../deploy/ssl/cert.pem");
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.resolve(__dirname, "../deploy/ssl/key.pem");

const DEFAULT_BIND_HOST = "0.0.0.0";
const STARTUP_WARNING = '[LAN Bridge] WARNING: unauthenticated — any device on the local network can reach the UI and execute shell commands via workspace_run_command. See README.md "LAN bridge security" section.';

function createProxyServer(listenPort) {
  const isHttps = listenPort === 443;

  const requestHandler = (req, res) => {
    const clientIp = req.socket.remoteAddress || "unknown";

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

if (require.main === module) {
  console.log("================================================================");
  console.log(STARTUP_WARNING);
  console.log("----------------------------------------------------------------");
  console.log("Starting LAN Reverse Proxy Bridges (Windows Defender Firewall Permitted)...");
  PORTS.map(createProxyServer).filter(Boolean);
  console.log("================================================================");
}

module.exports = {
  createProxyServer,
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
