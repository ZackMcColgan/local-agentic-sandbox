import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../app/api/deploy/route";

function makeDeployReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/deploy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: "localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/deploy deployBuild dryRunUrl SSRF guard (N-S1)", () => {
  const origDeployUrl = process.env.DEPLOY_URL;

  afterEach(() => {
    if (origDeployUrl === undefined) delete process.env.DEPLOY_URL;
    else process.env.DEPLOY_URL = origDeployUrl;
  });

  it("rejects cloud metadata and external dryRunUrl values with HTTP 400", async () => {
    const blockedUrls = [
      "http://169.254.169.254/latest/meta-data/",
      "http://example.com/",
      "https://evil.example.org/probe",
      "file:///etc/passwd",
      "http://user:pass@localhost:3000/",
      "not-a-url",
    ];

    for (const url of blockedUrls) {
      const res = await POST(
        makeDeployReq({
          action: "deployBuild",
          taskId: "nonexistent-task-ssrf-test",
          dryRunUrl: url,
        })
      );
      assert.equal(
        res.status,
        400,
        `Expected HTTP 400 for disallowed dryRunUrl '${url}', got ${res.status}`
      );
    }
  });

  it("allows cluster-internal hostnames and DEPLOY_URL origin to pass validation", async () => {
    process.env.DEPLOY_URL = "http://192.168.50.254:3000";

    const allowedUrls = [
      "http://localhost:3001/health",
      "http://127.0.0.1:3001/",
      "http://web-ui.local-agentic-sandbox.svc:3000/",
      "http://web-ui.local-agentic-sandbox.svc.cluster.local:3000/",
      "http://kind-gateway:8080/",
      "http://192.168.50.254:3000/health",
    ];

    for (const url of allowedUrls) {
      const res = await POST(
        makeDeployReq({
          action: "deployBuild",
          taskId: "nonexistent-task-ssrf-allow-test",
          dryRunUrl: url,
        })
      );
      // Passes URL validation and proceeds to checkpoint lookup -> 404 (no real deploy executed)
      assert.equal(
        res.status,
        404,
        `Expected allowed dryRunUrl '${url}' to pass validation and reach 404 task lookup, got ${res.status}`
      );
    }
  });
});
