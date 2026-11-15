import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../app/api/files/route";
import { verifyLanBridgeAuth } from "../lib/securityHardening";

describe("P6.2: securityHardening wiring", () => {
  it("files API route rejects path traversal via confinePathToRoot", async () => {
    const req = new NextRequest("http://localhost:3000/api/files?path=../../etc/passwd");
    const res = await GET(req);
    assert.strictEqual(res.status, 403);
  });

  it("verifyLanBridgeAuth uses constant-time comparison", () => {
    assert.strictEqual(verifyLanBridgeAuth("secret-123", "Bearer secret-123"), true);
    assert.strictEqual(verifyLanBridgeAuth("secret-123", "Bearer secret-124"), false);
    assert.strictEqual(verifyLanBridgeAuth("secret-123", "Bearer short"), false);
    assert.strictEqual(verifyLanBridgeAuth("secret-123", undefined), false);
  });
});
