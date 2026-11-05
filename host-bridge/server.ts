import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, execSync } from "child_process";
import { isDestructiveHostAction } from "./classifier";
import { getBridgeManifest } from "./manifest";

export interface HostServerOptions {
  port?: number;
  sharedSecret?: string;
  host?: string;
}

const MAX_OUTPUT_CHARS = 65536;
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_LIST_DIR_ITEMS = 500;

function constantTimeSecretEquals(provided: string | undefined, expected: string): boolean {
  if (!provided || typeof provided !== "string") {
    return false;
  }
  const hashProvided = crypto.createHash("sha256").update(provided).digest();
  const hashExpected = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

export function createHostServer(options: HostServerOptions = {}) {
  const port = options.port ?? (parseInt(process.env.PORT || "8765", 10) || 8765);
  const host = options.host || "127.0.0.1";

  // Resolve secret from options or environment
  let sharedSecret = options.sharedSecret !== undefined ? options.sharedSecret : process.env.HOST_RUNNER_SHARED_SECRET;
  if (!sharedSecret) {
    throw new Error("HOST_RUNNER_SHARED_SECRET environment variable is missing or empty. Server failing closed.");
  }
  if (sharedSecret.length < 32) {
    throw new Error("HOST_RUNNER_SHARED_SECRET must be at least 32 characters. Server failing closed.");
  }

  // Dual-layer approval consumption tracking: approvalId -> timestamp
  const consumedApprovals = new Map<string, number>();

  // Prune consumed approvals older than 1 hour periodically
  function pruneOldApprovals() {
    const oneHourAgo = Date.now() - 3600000;
    for (const [id, time] of consumedApprovals.entries()) {
      if (time < oneHourAgo) {
        consumedApprovals.delete(id);
      }
    }
  }

  const manifest = getBridgeManifest(__dirname);

  const server = http.createServer(async (req, res) => {
    // Zero CORS headers - NEVER set Access-Control-Allow-* headers.

    // 1. Validate Host header
    const hostHeader = (req.headers["host"] || "").toLowerCase().trim();
    const allowedHosts = [
      `host-runner-service:${port}`,
      `host.docker.internal:${port}`,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      "host-runner-service",
      "host.docker.internal",
      "127.0.0.1",
      "localhost"
    ];
    if (!allowedHosts.includes(hostHeader)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Request: Invalid Host header" }));
      return;
    }

    // 2. Browser-origin rejection: Check for Origin, Sec-Fetch-*, Access-Control-Request-*
    const userAgent = (req.headers["user-agent"] || "").toLowerCase();
    const isNodeFetch = userAgent === "node";

    for (const rawHeader of Object.keys(req.headers)) {
      const h = rawHeader.toLowerCase();
      if (h === "origin" || h.startsWith("access-control-request-")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: Browser-originated requests rejected" }));
        return;
      }
      if (h.startsWith("sec-fetch-")) {
        // Node's undici fetch automatically adds sec-fetch-mode: cors without user intervention.
        // If it's pure Node fetch sending only sec-fetch-mode without Origin or browser-specific Sec-Fetch headers, allow it.
        if (
          isNodeFetch &&
          h === "sec-fetch-mode" &&
          !req.headers["origin"] &&
          !req.headers["sec-fetch-site"] &&
          !req.headers["sec-fetch-dest"]
        ) {
          continue;
        }
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: Browser-originated requests rejected" }));
        return;
      }
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    // 3. GET /health route
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          protocolVersion: manifest.protocolVersion,
          bridgeSourceSha256: manifest.bridgeSourceSha256,
          pid: process.pid
        })
      );
      return;
    }

    // 4. POST /execute route
    if (req.method === "POST" && url.pathname === "/execute") {
      // PRE-PARSE authentication check: verify before reading body
      const authHeader = req.headers["x-host-runner-secret"];
      const secretStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;

      if (!constantTimeSecretEquals(secretStr, sharedSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // Read body
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", async () => {
        let body: any;
        try {
          const rawText = Buffer.concat(chunks).toString("utf8");
          body = JSON.parse(rawText);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        const tool = body.tool;
        const toolArgs = body.args || {};

        // Dual-layer approval gate: verify destructive actions
        const classification = isDestructiveHostAction(tool, toolArgs);
        if (classification.isDestructive) {
          const rawApproval = req.headers["x-host-approval-id"];
          const approvalId = Array.isArray(rawApproval) ? rawApproval[0] : rawApproval;

          if (!approvalId || typeof approvalId !== "string" || !approvalId.trim()) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Destructive host action requires explicit approval header (X-Host-Approval-Id)",
                reason: classification.reason
              })
            );
            return;
          }

          pruneOldApprovals();
          if (consumedApprovals.has(approvalId)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Approval ID already consumed: ${approvalId}`,
                approvalId
              })
            );
            return;
          }

          // Mark consumed immediately
          consumedApprovals.set(approvalId, Date.now());
        }

        try {
          const result = await handleToolExecution(tool, toolArgs, res);
          if (result !== undefined && !res.writableEnded) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          }
        } catch (err: any) {
          if (!res.writableEnded) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message || "Internal server error" }));
          }
        }
      });

      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  return {
    server,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

async function handleToolExecution(tool: string, args: any, res: http.ServerResponse): Promise<any> {
  let effectiveCwd = process.cwd();
  if (args && args.cwd && typeof args.cwd === "string" && args.cwd.trim()) {
    if (!fs.existsSync(args.cwd) || !fs.statSync(args.cwd).isDirectory()) {
      return { success: false, error: `Directory not found: ${args.cwd}` };
    }
    effectiveCwd = args.cwd;
  }

  if (tool === "host_run_powershell") {
    const command = String(args?.command || "");
    let timeoutSeconds = 120;
    if (typeof args?.timeoutSeconds === "number" && !isNaN(args.timeoutSeconds)) {
      timeoutSeconds = Math.max(1, Math.min(600, Math.floor(args.timeoutSeconds)));
    }

    return new Promise((resolve) => {
      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: effectiveCwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;

      proc.stdout?.on("data", (d) => {
        stdout += d.toString();
      });

      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      timer = setTimeout(() => {
        timedOut = true;
        const pid = proc.pid;
        if (pid) {
          try {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          } catch {}
          // Process tree survivor check
          try {
            const check = execSync(
              `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }"`,
              { encoding: "utf8", timeout: 3000 }
            );
            const pids = check
              .trim()
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
            for (const p of pids) {
              try {
                execSync(`taskkill /PID ${p} /T /F`, { stdio: "ignore" });
              } catch {}
            }
          } catch {}
        }
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, timeoutSeconds * 1000);

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);

        let combined = stdout;
        if (stderr) {
          if (combined) combined += "\n";
          combined += stderr;
        }

        const originalLength = combined.length;
        const truncated = originalLength > MAX_OUTPUT_CHARS;
        const clampedOutput = truncated ? combined.slice(0, MAX_OUTPUT_CHARS) : combined;

        if (timedOut) {
          resolve({
            success: false,
            timedOut: true,
            timeoutSeconds,
            output: clampedOutput,
            truncated,
            originalLength
          });
        } else {
          resolve({
            success: code === 0,
            exitCode: code ?? (code === null ? -1 : 0),
            output: clampedOutput,
            truncated,
            originalLength
          });
        }
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          success: false,
          error: err.message,
          output: "",
          truncated: false,
          originalLength: 0
        });
      });
    });
  }

  if (tool === "host_read_file") {
    const rawPath = String(args?.path || "");
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(effectiveCwd, rawPath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `File not found: ${rawPath}` };
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.size > MAX_FILE_READ_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `File exceeds 2MB limit: ${rawPath} (${stats.size} bytes)` }));
      return undefined;
    }

    const content = fs.readFileSync(resolvedPath, "utf8");
    const originalLength = content.length;
    const truncated = originalLength > MAX_OUTPUT_CHARS;
    const outputContent = truncated ? content.slice(0, MAX_OUTPUT_CHARS) : content;

    return {
      success: true,
      content: outputContent,
      truncated,
      originalLength
    };
  }

  if (tool === "host_write_file") {
    const rawPath = String(args?.path || "");
    const content = String(args?.content ?? "");
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(effectiveCwd, rawPath);

    let preImageExists = false;
    let preImageContent: string | null = null;
    let preImageTruncated = false;
    let preImageSha256: string | null = null;

    if (fs.existsSync(resolvedPath)) {
      preImageExists = true;
      try {
        const rawBytes = fs.readFileSync(resolvedPath);
        preImageSha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
        const fullText = rawBytes.toString("utf8");
        const origLen = fullText.length;
        if (origLen > MAX_OUTPUT_CHARS) {
          preImageContent = fullText.slice(0, MAX_OUTPUT_CHARS);
          preImageTruncated = true;
        } else {
          preImageContent = fullText;
          preImageTruncated = false;
        }
      } catch {
        preImageContent = null;
      }
    }

    const parent = path.dirname(resolvedPath);
    if (parent && !fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, content, "utf8");
    return {
      success: true,
      path: rawPath,
      preImageExists,
      preImageContent,
      preImageTruncated,
      preImageSha256
    };
  }

  if (tool === "host_list_dir") {
    const rawPath = String(args?.path || ".");
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(effectiveCwd, rawPath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `Path not found: ${rawPath}` };
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    const originalCount = entries.length;
    const truncated = originalCount > MAX_LIST_DIR_ITEMS;
    const items = entries.slice(0, MAX_LIST_DIR_ITEMS).map((entry) => {
      let size = 0;
      let lastWriteTime = "";
      try {
        const s = fs.statSync(path.join(resolvedPath, entry.name));
        size = s.size;
        lastWriteTime = s.mtime.toISOString();
      } catch {}
      return {
        name: entry.name,
        length: size,
        lastWriteTime,
        isDirectory: entry.isDirectory()
      };
    });

    return {
      success: true,
      items,
      truncated,
      originalCount
    };
  }

  if (tool === "host_delete_path") {
    const rawPath = String(args?.path || "");
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(effectiveCwd, rawPath);

    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: `Path not found: ${rawPath}` };
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory() && args?.recursive !== true) {
      return { success: false, error: "Directory deletion requires recursive: true" };
    }

    if (stats.isDirectory()) {
      fs.rmSync(resolvedPath, { recursive: true, force: true });
    } else {
      fs.rmSync(resolvedPath, { force: true });
    }

    return {
      success: true,
      path: rawPath
    };
  }

  return { error: `Unknown host tool: ${tool}` };
}
