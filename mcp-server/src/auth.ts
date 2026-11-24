import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

let devWarned = false;

export function verifySharedSecret(expected: string, provided: string | undefined): boolean {
  if (!expected || !provided) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function extractSharedSecretHeader(req: Request): string | undefined {
  const direct = req.headers["x-mcp-shared-secret"];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token.length > 0) return token;
  }
  return undefined;
}

export function buildAllowedHosts(
  serviceNames: string[],
  defaultPort: number,
  localPort?: number,
  extraEnv?: string
): string[] {
  const hosts = new Set<string>();
  const ports = new Set<number>([defaultPort]);
  if (typeof localPort === "number" && localPort > 0) {
    ports.add(localPort);
  }

  for (const name of [...serviceNames, "localhost", "127.0.0.1", "[::1]"]) {
    hosts.add(name);
    for (const p of ports) {
      hosts.add(`${name}:${p}`);
    }
  }

  if (extraEnv) {
    for (const entry of extraEnv.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) hosts.add(trimmed);
    }
  }
  return Array.from(hosts);
}

export function createMcpAuthMiddleware() {
  return function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env.MCP_SHARED_SECRET?.trim() || "";
    if (!expected) {
      if (process.env.NODE_ENV === "development") {
        if (!devWarned) {
          devWarned = true;
          console.warn(
            "[MCP Auth] WARNING: MCP_SHARED_SECRET is not set; allowing request in NODE_ENV=development"
          );
        }
        next();
        return;
      }
      console.error(
        "[MCP Auth] FATAL: MCP_SHARED_SECRET is not configured; refusing request (fail-closed)"
      );
      res.status(503).json({ error: "MCP_SHARED_SECRET is not configured" });
      return;
    }

    const provided = extractSharedSecretHeader(req);
    if (!verifySharedSecret(expected, provided)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
