/**
 * Security: bridge approval tokens must be bound to the exact tool + payload.
 *
 * Rejection classes (one test each):
 *  1. Invented token rejected.
 *  2. Reused (replayed) token rejected.
 *  3. Expired token rejected.
 *  4. Token presented for a different payload rejected.
 *  5. A correctly bound token approves exactly once.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createHostServer } from "../../host-bridge/server";
import { issueApprovalToken, MAX_APPROVAL_TOKEN_TTL_MS } from "../../host-bridge/approvalToken";

const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_PORT = 18767;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Host-Runner-Secret": TEST_SECRET,
    Host: `127.0.0.1:${TEST_PORT}`,
    ...extra,
  };
}

async function execute(
  base: string,
  tool: string,
  args: Record<string, unknown>,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/execute`, {
    method: "POST",
    headers: authHeaders(token ? { "X-Host-Approval-Id": token } : {}),
    body: JSON.stringify({ tool, args }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("Approval Token Binding Suite (Board #131)", () => {
  let server: ReturnType<typeof createHostServer>;
  let base: string;
  let tempDir: string;

  before(async () => {
    server = createHostServer({ port: TEST_PORT, sharedSecret: TEST_SECRET });
    await server.start();
    base = `http://127.0.0.1:${TEST_PORT}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-binding-"));
  });

  after(async () => {
    if (server) await server.stop();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function victimFile(name: string): string {
    const p = path.join(tempDir, name);
    fs.writeFileSync(p, "content", "utf8");
    return p;
  }

  it("rejects an invented token for a destructive action (403, no execution)", async () => {
    const victim = victimFile("invented.txt");
    const { status, body } = await execute(
      base,
      "host_delete_path",
      { path: victim },
      "approval-00000000-0000-0000-0000-000000000000.99999999999999.99999999999999.deadbeef"
    );
    assert.equal(status, 403, `invented token must be rejected, got ${status}`);
    assert.ok(String(body.error).toLowerCase().includes("approval"), "403 must mention approval");
    assert.ok(fs.existsSync(victim), "invented token must not execute the deletion");
  });

  it("rejects a reused token (409 on replay, second execution does not happen)", async () => {
    const victim = victimFile("replay.txt");
    const token = issueApprovalToken(TEST_SECRET, "host_delete_path", { path: victim });
    const first = await execute(base, "host_delete_path", { path: victim }, token);
    assert.equal(first.status, 200, `first use must succeed, got ${first.status}`);
    assert.ok(!fs.existsSync(victim), "first approved execution must delete the file");

    // Replay the SAME token for the SAME payload -> single-use conflict (409).
    const replay = await execute(base, "host_delete_path", { path: victim }, token);
    assert.equal(replay.status, 409, `replayed token must conflict, got ${replay.status}`);
    assert.ok(String(replay.body.error).includes("consumed"), "409 must report consumed");
  });

  it("rejects an expired token (403, no execution)", async () => {
    const victim = victimFile("expired.txt");
    const issuedAt = Date.now() - 6 * 60 * 1000; // issued 6 minutes ago
    const token = issueApprovalToken(
      TEST_SECRET,
      "host_delete_path",
      { path: victim },
      {
        issuedAt,
        ttlMs: 5 * 60 * 1000,
      }
    );
    const { status, body } = await execute(base, "host_delete_path", { path: victim }, token);
    assert.equal(status, 403, `expired token must be rejected, got ${status}`);
    assert.ok(String(body.error).toLowerCase().includes("expired"), "403 must report expiry");
    assert.ok(fs.existsSync(victim), "expired token must not execute the deletion");
  });

  it("rejects a token presented for a different payload (403, no execution)", async () => {
    const victim = victimFile("bound.txt");
    const other = victimFile("other.txt");
    const token = issueApprovalToken(TEST_SECRET, "host_delete_path", { path: victim });
    const { status, body } = await execute(base, "host_delete_path", { path: other }, token);
    assert.equal(status, 403, `payload-mismatched token must be rejected, got ${status}`);
    assert.ok(
      String(body.error).toLowerCase().includes("payload"),
      "403 must report payload mismatch"
    );
    assert.ok(fs.existsSync(victim), "mismatched token must not delete the bound file");
    assert.ok(fs.existsSync(other), "mismatched token must not delete the other file");
  });

  it("rejects a token presented for a different tool (403, no execution)", async () => {
    const victim = victimFile("toolswap.txt");
    const token = issueApprovalToken(TEST_SECRET, "host_delete_path", { path: victim });
    const { status } = await execute(
      base,
      "host_run_powershell",
      { command: `Remove-Item -Path "${victim}"` },
      token
    );
    assert.equal(status, 403, `tool-swapped token must be rejected, got ${status}`);
    assert.ok(fs.existsSync(victim), "tool-swapped token must not execute the deletion");
  });

  it("rejects a token whose TTL exceeds the 5-minute maximum", async () => {
    assert.equal(MAX_APPROVAL_TOKEN_TTL_MS, 5 * 60 * 1000);
    const victim = victimFile("longttl.txt");

    // Minting an over-TTL token is refused outright (policy violation, not clamped).
    assert.throws(
      () =>
        issueApprovalToken(
          TEST_SECRET,
          "host_delete_path",
          { path: victim },
          {
            ttlMs: 10 * 60 * 1000,
          }
        ),
      /TTL must be between/
    );

    // A hand-forged token claiming a 10-minute TTL must still be rejected by the bridge.
    const forged =
      `${crypto.randomUUID()}.${Date.now()}.${Date.now() + 10 * 60 * 1000}` +
      ".0000000000000000000000000000000000000000000000000000000000000000";
    const { status } = await execute(base, "host_delete_path", { path: victim }, forged);
    assert.equal(status, 403, `over-TTL token must be rejected, got ${status}`);
    assert.ok(fs.existsSync(victim), "over-TTL token must not execute the deletion");
  });

  it("a correctly bound token approves exactly once", async () => {
    const victim = victimFile("once.txt");
    const token = issueApprovalToken(TEST_SECRET, "host_delete_path", { path: victim });
    const ok = await execute(base, "host_delete_path", { path: victim }, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
    assert.ok(!fs.existsSync(victim));

    // Same token again -> conflict; exactly-once semantics hold.
    const again = await execute(base, "host_delete_path", { path: victim }, token);
    assert.equal(again.status, 409);

    // A fresh bound token for a new payload still works (binding is per-approval).
    const victim2 = victimFile("once2.txt");
    const token2 = issueApprovalToken(TEST_SECRET, "host_delete_path", { path: victim2 });
    const ok2 = await execute(base, "host_delete_path", { path: victim2 }, token2);
    assert.equal(ok2.status, 200);
    assert.ok(!fs.existsSync(victim2));
  });

  it("missing token on a destructive action still returns 403 (existing gate preserved)", async () => {
    const victim = victimFile("missing.txt");
    const { status, body } = await execute(base, "host_delete_path", { path: victim });
    assert.equal(status, 403);
    assert.ok(String(body.error).includes("approval"), "missing-token gate preserved");
    assert.ok(fs.existsSync(victim));
  });
});
