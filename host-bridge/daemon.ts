import http from "http";
import { createHostServer } from "./server";
import { getBridgeManifest } from "./manifest";

async function probeHealth(port: number): Promise<{ ok: boolean; sha?: string }> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        timeout: 2000,
        headers: { Host: `127.0.0.1:${port}` }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode === 200 && parsed.status === "ok") {
              resolve({ ok: true, sha: parsed.bridgeSourceSha256 });
              return;
            }
          } catch {}
          resolve({ ok: false });
        });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

export async function runDaemon() {
  const port = parseInt(process.env.PORT || "8765", 10) || 8765;
  const manifest = getBridgeManifest(__dirname);

  console.log(`[HostRunner] Starting Host Runner Daemon (Node 22 SEA)`);
  console.log(`[HostRunner] Protocol Version: ${manifest.protocolVersion}`);
  console.log(`[HostRunner] Bridge Source SHA-256: ${manifest.bridgeSourceSha256}`);

  // Create server (will fail closed if HOST_RUNNER_SHARED_SECRET is invalid)
  let hostServer: ReturnType<typeof createHostServer>;
  try {
    hostServer = createHostServer({ port });
  } catch (err: any) {
    console.error(`[HostRunner] Fatal configuration error: ${err.message}`);
    process.exit(1);
  }

  try {
    await hostServer.start();
    console.log(`[HostRunner] Bound strictly to 127.0.0.1:${port} (PID: ${process.pid})`);
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      console.warn(`[HostRunner] Port ${port} is already in use. Probing running instance /health...`);
      const probe = await probeHealth(port);
      if (probe.ok && probe.sha === manifest.bridgeSourceSha256) {
        console.log(`[HostRunner] Compatible daemon already running with matching SHA-256 (${manifest.bridgeSourceSha256}). Exiting cleanly (0).`);
        process.exit(0);
      } else {
        console.error(
          `[HostRunner] Existing process on port ${port} has mismatched SHA-256 (${probe.sha} vs current ${manifest.bridgeSourceSha256}) or failed health check. Exiting (1).`
        );
        process.exit(1);
      }
    } else {
      console.error(`[HostRunner] Failed to bind: ${err.message}`);
      process.exit(1);
    }
  }

  // Graceful shutdown handling
  const shutdown = async () => {
    console.log("[HostRunner] Shutting down daemon...");
    await hostServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// When invoked directly
if (require.main === module) {
  runDaemon().catch((err) => {
    console.error(`[HostRunner] Unhandled daemon error:`, err);
    process.exit(1);
  });
}
