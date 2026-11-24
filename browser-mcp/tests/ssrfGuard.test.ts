import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isBlockedIp,
  validateUrlForSsrf,
  safeFetchWithSsrfGuard,
  SsrfBlockedError,
  type DnsLookupFn,
} from "../src/tools/ssrfGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Browser MCP SSRF Guard", () => {
  describe("IPv4, IPv6, and non-decimal loopback / private forms", () => {
    const blockedUrls = [
      // Standard loopback & metadata
      "http://localhost/secret",
      "http://localhost./secret",
      "http://sub.localhost/secret",
      "http://127.0.0.1/admin",
      "http://127.0.0.2/admin",
      "http://127.255.255.254/admin",
      "http://0.0.0.0/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/router",
      "http://172.16.0.1/internal",
      "http://172.31.255.254/internal",
      "http://192.168.1.1/gateway",
      "http://100.64.0.1/cgnat",
      // Non-decimal & shortened loopback / private IPv4 forms
      "http://2130706433/admin", // decimal 127.0.0.1
      "http://0x7f000001/admin", // hex 127.0.0.1
      "http://0x7f.0.0.1/admin", // dotted hex 127.0.0.1
      "http://0177.0.0.1/admin", // octal 127.0.0.1
      "http://127.1/admin", // shortened 127.0.0.1
      "http://127.0.1/admin", // shortened 127.0.0.1
      "http://2852039166/latest/meta-data/", // decimal 169.254.169.254
      "http://0/admin", // decimal 0.0.0.0
      // IPv6 loopback, unspecified, link-local, unique-local, IPv4-mapped
      "http://[::1]/admin",
      "http://[0:0:0:0:0:0:0:1]/admin",
      "http://[::]/admin",
      "http://[::ffff:127.0.0.1]/admin",
      "http://[::ffff:7f00:1]/admin",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:10.0.0.1]/internal",
      "http://[fe80::1]/link-local",
      "http://[fc00::1]/ula",
      "http://[fd12:3456:789a::1]/ula",
      // Non-HTTP(S) protocols & internal TLDs
      "file:///etc/passwd",
      "http://service.local/api",
      "http://metadata.google.internal/computeMetadata/v1/",
    ];

    it("blocks all private, loopback, IPv6, and non-decimal loopback URL forms", async () => {
      const publicDns: DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
      for (const url of blockedUrls) {
        const verdict = await validateUrlForSsrf(url, { lookup: publicDns });
        assert.equal(verdict.allowed, false, `Expected URL to be blocked: ${url}`);
      }
    });

    it("correctly classifies raw IPv4 and IPv6 addresses via isBlockedIp", () => {
      assert.equal(isBlockedIp("127.0.0.1"), true);
      assert.equal(isBlockedIp("127.0.0.42"), true);
      assert.equal(isBlockedIp("::1"), true);
      assert.equal(isBlockedIp("0:0:0:0:0:0:0:1"), true);
      assert.equal(isBlockedIp("::ffff:127.0.0.1"), true);
      assert.equal(isBlockedIp("::ffff:7f00:1"), true);
      assert.equal(isBlockedIp("fe80::1"), true);
      assert.equal(isBlockedIp("fd00::1"), true);
      assert.equal(isBlockedIp("93.184.216.34"), false);
      assert.equal(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946"), false);
    });
  });

  describe("DNS resolution check", () => {
    it("blocks a public-looking hostname that resolves to a private or loopback IP", async () => {
      const rebindDns: DnsLookupFn = async (hostname) => {
        if (hostname === "rebind-v4.example.com") {
          return [{ address: "127.0.0.1", family: 4 }];
        }
        if (hostname === "rebind-v6.example.com") {
          return [{ address: "::1", family: 6 }];
        }
        if (hostname === "rebind-meta.example.com") {
          return [
            { address: "93.184.216.34", family: 4 },
            { address: "169.254.169.254", family: 4 },
          ];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      };

      for (const host of [
        "rebind-v4.example.com",
        "rebind-v6.example.com",
        "rebind-meta.example.com",
      ]) {
        const verdict = await validateUrlForSsrf(`https://${host}/path`, { lookup: rebindDns });
        assert.equal(verdict.allowed, false, `Expected DNS-rebound host ${host} to be blocked`);
      }
    });

    it("fails closed when DNS resolution fails", async () => {
      const failingDns: DnsLookupFn = async () => {
        throw new Error("ENOTFOUND");
      };
      const verdict = await validateUrlForSsrf("https://nonexistent.invalid/", {
        lookup: failingDns,
      });
      assert.equal(verdict.allowed, false, "DNS lookup failure must fail closed");
    });
  });

  describe("Redirect hop re-validation & allowed public URL", () => {
    it("blocks a public URL that redirects to a loopback or private destination", async () => {
      const dnsLookup: DnsLookupFn = async (hostname) => {
        if (hostname === "public.example.com") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        if (hostname === "internal-hop.example.com") {
          return [{ address: "10.0.0.5", family: 4 }];
        }
        return [{ address: "93.184.216.34", family: 4 }];
      };

      const redirectToLoopback: typeof fetch = async (input) => {
        const url = String(input);
        if (url === "https://public.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:8080/secret" },
          });
        }
        throw new Error(`Fetch must not follow blocked redirect target: ${url}`);
      };

      await assert.rejects(
        () =>
          safeFetchWithSsrfGuard(
            "https://public.example.com/start",
            {},
            { fetchFn: redirectToLoopback, lookup: dnsLookup }
          ),
        SsrfBlockedError
      );

      const redirectToReboundHost: typeof fetch = async (input) => {
        const url = String(input);
        if (url === "https://public.example.com/hop") {
          return new Response(null, {
            status: 301,
            headers: { location: "https://internal-hop.example.com/admin" },
          });
        }
        throw new Error(`Fetch must not follow DNS-rebound redirect target: ${url}`);
      };

      await assert.rejects(
        () =>
          safeFetchWithSsrfGuard(
            "https://public.example.com/hop",
            {},
            { fetchFn: redirectToReboundHost, lookup: dnsLookup }
          ),
        SsrfBlockedError
      );
    });

    it("allows a public URL (including public-to-public redirect) that resolves to a public IP", async () => {
      const publicDns: DnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url === "https://example.com/old") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.com/docs" },
          });
        }
        if (url === "https://example.com/docs") {
          return new Response("<html><body><h1>Public Docs</h1></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const res = await safeFetchWithSsrfGuard(
        "https://example.com/old",
        {},
        { fetchFn: mockFetch, lookup: publicDns }
      );
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes("Public Docs"));
    });
  });

  describe("CORS hardening", () => {
    it("does not enable wildcard cors() in browser-mcp/src/index.ts", () => {
      const indexPath = path.resolve(__dirname, "../src/index.ts");
      const src = fs.readFileSync(indexPath, "utf8");
      assert.doesNotMatch(
        src,
        /app\.use\(\s*cors\(\s*\)\s*\)/,
        "browser-mcp/src/index.ts must not use wildcard app.use(cors())"
      );
      assert.doesNotMatch(
        src,
        /Access-Control-Allow-Origin['"]?\s*[:=,]\s*['"]\*['"]/,
        "browser-mcp/src/index.ts must not emit wildcard Access-Control-Allow-Origin: *"
      );
    });
  });
});
