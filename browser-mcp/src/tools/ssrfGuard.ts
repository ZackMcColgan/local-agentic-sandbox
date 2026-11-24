import dns from "node:dns";
import net from "node:net";

export interface DnsLookupAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string, options: { all: true }) => Promise<DnsLookupAddress[]>;

export interface SsrfValidationResult {
  allowed: boolean;
  reason?: string;
  resolvedIps?: string[];
}

export class SsrfBlockedError extends Error {
  public readonly url: string;
  public readonly reason: string;

  constructor(url: string, reason: string) {
    super(`SSRF blocked for ${url}: ${reason}`);
    this.name = "SsrfBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

const defaultLookup: DnsLookupFn = async (hostname, options) => {
  const result = await dns.promises.lookup(hostname, options);
  return Array.isArray(result) ? result : [result];
};

function parseIpv4Part(part: string): number | null {
  if (!part) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const val = Number.parseInt(part.slice(2), 16);
    return Number.isFinite(val) ? val : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const val = Number.parseInt(part, 8);
    return Number.isFinite(val) ? val : null;
  }
  if (/^\d+$/.test(part)) {
    const val = Number.parseInt(part, 10);
    return Number.isFinite(val) ? val : null;
  }
  return null;
}

/**
 * Parses standard and non-decimal/shortened IPv4 notations (decimal integer,
 * hex, octal, 1/2/3/4-part dotted forms) into canonical dotted-quad IPv4.
 */
export function parseNonStandardIpv4(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed || trimmed.includes(":")) return null;

  const parts = trimmed.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    const parsed = parseIpv4Part(part);
    if (parsed === null || parsed < 0) return null;
    nums.push(parsed);
  }

  let addr32: number;
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null;
    addr32 = nums[0] >>> 0;
  } else if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
    addr32 = (((nums[0] << 24) >>> 0) | (nums[1] >>> 0)) >>> 0;
  } else if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
    addr32 = (((nums[0] << 24) >>> 0) | ((nums[1] << 16) >>> 0) | (nums[2] >>> 0)) >>> 0;
  } else {
    if (nums.some((n) => n > 0xff)) return null;
    addr32 =
      (((nums[0] << 24) >>> 0) |
        ((nums[1] << 16) >>> 0) |
        ((nums[2] << 8) >>> 0) |
        (nums[3] >>> 0)) >>>
      0;
  }

  return [
    (addr32 >>> 24) & 0xff,
    (addr32 >>> 16) & 0xff,
    (addr32 >>> 8) & 0xff,
    addr32 & 0xff,
  ].join(".");
}

function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split(".").map((s) => Number.parseInt(s, 10));
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return true;
  }
  const [a, b, c] = octets;

  if (a === 0) return true; // 0.0.0.0/8 (unspecified / current network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved/broadcast)

  return false;
}

function expandIpv6(raw: string): number[] | null {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.slice(0, zoneIdx);
  }
  if (!ip.includes(":")) return null;

  // Handle embedded IPv4 tail (e.g., ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseNonStandardIpv4(tail);
    if (!v4) return null;
    const octets = v4.split(".").map((n) => Number.parseInt(n, 10));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(":");
    const groups: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSide(doubleColonParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSide(doubleColonParts[0]);
  const right = parseSide(doubleColonParts[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(raw: string): boolean {
  const g = expandIpv6(raw);
  if (!g) return true;

  // :: (unspecified) and ::1 (loopback)
  const allZeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (allZeroPrefix && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
    return true;
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (allZeroPrefix && g[5] === 0xffff) {
    const v4 = `${(g[6] >>> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >>> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // ::ffff:0:0:0/96 (IPv4-translated)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
    const v4 = `${(g[6] >>> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >>> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // 64:ff9b::/96 (NAT64 well-known prefix)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const v4 = `${(g[6] >>> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >>> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // 2002::/16 (6to4 embedded IPv4)
  if (g[0] === 0x2002) {
    const v4 = `${(g[1] >>> 8) & 0xff}.${g[1] & 0xff}.${(g[2] >>> 8) & 0xff}.${g[2] & 0xff}`;
    if (isBlockedIpv4(v4)) return true;
  }

  // 100::/64 (discard-only)
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

  // 2001:db8::/32 (documentation)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;

  // fc00::/7 (unique local addresses)
  if ((g[0] & 0xfe00) === 0xfc00) return true;

  // fe80::/10 (link-local)
  if ((g[0] & 0xffc0) === 0xfe80) return true;

  // ff00::/8 (multicast)
  if ((g[0] & 0xff00) === 0xff00) return true;

  return false;
}

export function isBlockedIp(raw: string): boolean {
  const cleaned = raw.trim().replace(/^\[|\]$/g, "");
  if (!cleaned) return true;

  if (cleaned.includes(":")) {
    return isBlockedIpv6(cleaned);
  }

  const normalizedV4 = parseNonStandardIpv4(cleaned);
  if (normalizedV4) {
    return isBlockedIpv4(normalizedV4);
  }

  if (net.isIPv4(cleaned)) {
    return isBlockedIpv4(cleaned);
  }

  return true;
}

function normalizeHostname(rawHostname: string): string {
  return rawHostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isBlockedHostnameLiteral(host: string): string | null {
  if (!host) return "Empty hostname";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "localhost.localdomain"
  ) {
    return `Blocked local/internal hostname '${host}'`;
  }

  if (host.includes(":")) {
    return isBlockedIpv6(host) ? `Blocked IPv6 address '${host}'` : null;
  }

  const parsedV4 = parseNonStandardIpv4(host);
  if (parsedV4) {
    return isBlockedIpv4(parsedV4) ? `Blocked IPv4 address '${parsedV4}'` : null;
  }

  return null;
}

export async function validateUrlForSsrf(
  urlString: string,
  deps?: { lookup?: DnsLookupFn }
): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: "Malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Disallowed protocol '${parsed.protocol}'` };
  }

  const host = normalizeHostname(parsed.hostname);
  const literalBlockReason = isBlockedHostnameLiteral(host);
  if (literalBlockReason) {
    return { allowed: false, reason: literalBlockReason };
  }

  // If the hostname is already a valid literal public IP, no DNS lookup is required.
  if (net.isIP(host) !== 0) {
    return isBlockedIp(host)
      ? { allowed: false, reason: `Blocked IP address '${host}'` }
      : { allowed: true, resolvedIps: [host] };
  }

  const lookup = deps?.lookup ?? defaultLookup;
  let records: DnsLookupAddress[];
  try {
    records = await lookup(host, { all: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { allowed: false, reason: `DNS resolution failed for '${host}': ${msg}` };
  }

  if (!records || records.length === 0) {
    return { allowed: false, reason: `DNS resolution returned no addresses for '${host}'` };
  }

  const resolvedIps = records.map((r) => r.address);
  for (const ip of resolvedIps) {
    if (isBlockedIp(ip)) {
      return {
        allowed: false,
        reason: `Hostname '${host}' resolved to blocked IP '${ip}'`,
        resolvedIps,
      };
    }
  }

  return { allowed: true, resolvedIps };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetchWithSsrfGuard(
  urlString: string,
  init: RequestInit = {},
  deps?: {
    fetchFn?: typeof fetch;
    lookup?: DnsLookupFn;
    maxRedirects?: number;
  }
): Promise<Response> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const maxRedirects = deps?.maxRedirects ?? 5;

  let currentUrl = urlString;
  let currentInit: RequestInit = { ...init, redirect: "manual" };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = await validateUrlForSsrf(currentUrl, { lookup: deps?.lookup });
    if (!verdict.allowed) {
      throw new SsrfBlockedError(currentUrl, verdict.reason || "Blocked by SSRF policy");
    }

    const res = await fetchFn(currentUrl, currentInit);

    if (!REDIRECT_STATUSES.has(res.status)) {
      return res;
    }

    const location = res.headers.get("location");
    if (!location) {
      return res;
    }

    if (hop === maxRedirects) {
      throw new SsrfBlockedError(currentUrl, `Exceeded maximum redirect hops (${maxRedirects})`);
    }

    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new SsrfBlockedError(location, "Malformed redirect Location header");
    }

    // Per HTTP spec, 303 (or 301/302 on POST) switches subsequent hop to GET without body
    const method = (currentInit.method || "GET").toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      currentInit = { ...currentInit, method: "GET", body: undefined, redirect: "manual" };
    }
  }

  throw new SsrfBlockedError(urlString, `Exceeded maximum redirect hops (${maxRedirects})`);
}
