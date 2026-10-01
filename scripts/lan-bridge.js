/**
 * LAN Reverse Proxy Bridge for local-agentic-sandbox
 * 
 * Purpose: Windows Defender Firewall actively blocks inbound external connections
 * to Docker Desktop's binary (com.docker.backend.exe), preventing mobile/LAN devices
 * from accessing container ports directly. However, node.exe is explicitly ALLOWED
 * inbound across all profiles.
 * 
 * This zero-dependency bridge binds node.exe to 0.0.0.0 on port 80 (standard HTTP)
 * and port 3000 (legacy/dev port) on the host, permitting external LAN devices
 * (e.g. mobile phones on 192.168.50.x) to connect cleanly by IP alone without specifying a port!
 */

const http = require("http");
const net = require("net");

const TARGET_PORT = parseInt(process.env.TARGET_PORT || "3001", 10);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";
const PORTS = process.env.LISTEN_PORTS
  ? process.env.LISTEN_PORTS.split(",").map((p) => parseInt(p.trim(), 10))
  : [80, 3000];

function createProxyServer(listenPort) {
  const server = http.createServer((req, res) => {
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
        "x-forwarded-proto": "http",
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
      proxyRes.pipe(res, { end: true });

      proxyRes.on("end", () => {
        console.log(`[LAN Bridge :${listenPort}] ${new Date().toISOString().slice(11, 19)} | ${clientIp} | ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
      });
    });

    proxyReq.on("error", (err) => {
      console.error(`[LAN Bridge :${listenPort} Error] ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
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
    });

    // Pipe incoming request body to target (e.g. POST /api/chat)
    req.pipe(proxyReq, { end: true });
  });

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

  server.listen(listenPort, "0.0.0.0", () => {
    console.log(`[LAN Bridge Active] Listening on 0.0.0.0:${listenPort} -> Forwarding to http://${TARGET_HOST}:${TARGET_PORT}`);
    if (listenPort === 80) {
      console.log(`  -> Direct Browser URL: http://192.168.50.254/ (no port needed)`);
    } else {
      console.log(`  -> Port URL: http://192.168.50.254:${listenPort}`);
    }
  });

  server.on("error", (err) => {
    console.error(`[LAN Bridge Error on port ${listenPort}]:`, err.message);
  });

  return server;
}

console.log("================================================================");
console.log("Starting LAN Reverse Proxy Bridges (Windows Defender Firewall Permitted)...");
PORTS.forEach(createProxyServer);
console.log("================================================================");
