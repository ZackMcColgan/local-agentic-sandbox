import path from "path";
import crypto from "crypto";

export function confinePathToRoot(rootDir: string, userPath: string): string {
  const rootResolved = path.resolve(rootDir);
  const targetResolved = path.resolve(rootResolved, userPath.replace(/^[/\\]+/, ""));
  if (targetResolved !== rootResolved && !targetResolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Security Violation: Path traversal outside root (${userPath})`);
  }
  return targetResolved;
}

export function isSafePublicUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return false;
  }
  return true;
}

export function verifyLanBridgeAuth(expectedToken: string, authHeader?: string): boolean {
  if (!expectedToken || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
