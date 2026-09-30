/**
 * LAN Reverse Proxy Bridge for local-agentic-sandbox
 * 
 * Purpose: Windows Defender Firewall actively blocks inbound external connections
 * to Docker Desktop's binary (com.docker.backend.exe), preventing mobile/LAN devices
 * from accessing container ports directly. However, node.exe is explicitly ALLOWED
 * inbound across all profiles.
 * 
 * This zero-dependency bridge binds node.exe to 0.0.0.0:3000 on the host, permitting
 * external LAN devices (e.g. mobile phones on 192.168.50.x) to connect cleanly,
 * and proxies all HTTP, SSE streams, and WebSocket traffic to the Docker container at 127.0.0.1:3001.
 */

const http = require("http");
const net = require("net");

const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || "3000", 10);
const TARGET_PORT = parseInt(process.env.TARGET_PORT || "3001", 10);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  const clientIp = req.socket.remoteAddress || "unknown";

  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`,
      "x-forwarded-for": clientIp,
      "x-forwarded-proto": "http",
      "x-real-ip": clientIp,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Preserve response headers and status
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    // Stream response chunks directly with backpressure
    proxyRes.pipe(res, { end: true });

    proxyRes.on("end", () => {
      console.log(`[LAN Bridge] ${new Date().toISOString().slice(11, 19)} | ${clientIp} | ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[LAN Bridge Error] ${req.method} ${req.url}:`, err.message);
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
    console.error("[LAN Bridge WS Error]:", err.message);
    socket.destroy();
  });

  socket.on("error", () => {
    proxySocket.destroy();
  });
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`================================================================`);
  console.log(`[LAN Bridge Active]`);
  console.log(`Listening on: 0.0.0.0:${LISTEN_PORT} (Permitted by Windows Defender Firewall)`);
  console.log(`Forwarding to: http://${TARGET_HOST}:${TARGET_PORT} (Docker enterprise-ai-portal)`);
  console.log(`External LAN URL: http://192.168.50.254:${LISTEN_PORT}`);
  console.log(`================================================================`);
});
