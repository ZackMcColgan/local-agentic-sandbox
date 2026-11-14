import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostServer } from "../../host-bridge/server";

const SECRET = "test-async-jobs-secret-32-chars-min!";

let nextPort = 18781;

async function startTestServer(jobsDir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const port = nextPort++;
  const hostServer = createHostServer({
    port,
    sharedSecret: SECRET,
    jobsDir
  });
  await hostServer.start();
  return {
    port,
    close: () => hostServer.stop()
  };
}

async function reqJson(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      "x-host-runner-secret": SECRET,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

describe("Host Bridge Async Jobs (P1.1)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("starts an async job, keeps /health responsive, streams output by offset, and completes with exitCode", async () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-jobs-test-"));
    const srv = await startTestServer(jobsDir);
    cleanups.push(async () => {
      await srv.close();
      fs.rmSync(jobsDir, { recursive: true, force: true });
    });

    const t0 = Date.now();
    const startRes = await reqJson(srv.port, "POST", "/jobs/start", {
      tool: "run_command",
      args: {
        command: `node -e "console.log('CHUNK_1'); setTimeout(() => { console.log('CHUNK_2'); process.exit(0); }, 800);"`,
        cwd: os.tmpdir()
      }
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(startRes.status, 202, `Expected 202, got ${startRes.status}: ${JSON.stringify(startRes.data)}`);
    assert.ok(startRes.data.jobId, "Expected jobId");
    assert.ok(elapsed < 1000, `Expected immediate return, took ${elapsed}ms`);

    const jobId = startRes.data.jobId;

    // /health must answer 200 immediately while job runs
    const healthRes = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.strictEqual(healthRes.status, 200);

    // Poll until completed
    let statusData: any;
    for (let i = 0; i < 40; i++) {
      const st = await reqJson(srv.port, "GET", `/jobs/${jobId}/status`);
      assert.strictEqual(st.status, 200);
      statusData = st.data;
      if (statusData.status !== "running") break;
      await new Promise((r) => setTimeout(r, 150));
    }

    assert.strictEqual(statusData.status, "completed");
    assert.strictEqual(statusData.exitCode, 0);

    // Read output in two offset chunks
    const out1 = await reqJson(srv.port, "GET", `/jobs/${jobId}/output?offset=0&limit=8`);
    assert.strictEqual(out1.status, 200);
    assert.strictEqual(out1.data.data.length, 8);

    const out2 = await reqJson(srv.port, "GET", `/jobs/${jobId}/output?offset=${out1.data.nextOffset}&limit=1024`);
    assert.strictEqual(out2.status, 200);
    const fullOutput = out1.data.data + out2.data.data;
    assert.ok(fullOutput.includes("CHUNK_1"), `Missing CHUNK_1 in: ${fullOutput}`);
    assert.ok(fullOutput.includes("CHUNK_2"), `Missing CHUNK_2 in: ${fullOutput}`);
  });

  it("cancels a running async job and reports status=cancelled", async () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-jobs-cancel-"));
    const srv = await startTestServer(jobsDir);
    cleanups.push(async () => {
      await srv.close();
      fs.rmSync(jobsDir, { recursive: true, force: true });
    });

    const startRes = await reqJson(srv.port, "POST", "/jobs/start", {
      tool: "run_command",
      args: {
        command: `node -e "setInterval(() => {}, 1000)"`,
        cwd: os.tmpdir()
      }
    });
    assert.strictEqual(startRes.status, 202, `Expected 202, got ${startRes.status}: ${JSON.stringify(startRes.data)}`);
    const jobId = startRes.data.jobId;

    const cancelRes = await reqJson(srv.port, "POST", `/jobs/${jobId}/cancel`);
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelRes.data.status, "cancelled");

    const st = await reqJson(srv.port, "GET", `/jobs/${jobId}/status`);
    assert.strictEqual(st.data.status, "cancelled");
  });

  it("marks in-flight jobs as interrupted when daemon restarts", async () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-jobs-restart-"));
    const srv1 = await startTestServer(jobsDir);

    const startRes = await reqJson(srv1.port, "POST", "/jobs/start", {
      tool: "run_command",
      args: {
        command: `node -e "setInterval(() => {}, 1000)"`,
        cwd: os.tmpdir()
      }
    });
    assert.strictEqual(startRes.status, 202, `Expected 202, got ${startRes.status}: ${JSON.stringify(startRes.data)}`);
    const jobId = startRes.data.jobId;

    // Simulate daemon restart
    await srv1.close();

    const srv2 = await startTestServer(jobsDir);
    cleanups.push(async () => {
      await srv2.close();
      fs.rmSync(jobsDir, { recursive: true, force: true });
    });

    const st = await reqJson(srv2.port, "GET", `/jobs/${jobId}/status`);
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.data.status, "interrupted");
  });

  it("enforces destructive classification at /jobs/start before execution", async () => {
    const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-jobs-destruct-"));
    const srv = await startTestServer(jobsDir);
    cleanups.push(async () => {
      await srv.close();
      fs.rmSync(jobsDir, { recursive: true, force: true });
    });

    const res = await reqJson(srv.port, "POST", "/jobs/start", {
      tool: "host_run_powershell",
      args: {
        command: "Remove-Item -Recurse -Force C:\\nonexistent-test-dir",
        cwd: os.tmpdir()
      }
    });
    assert.strictEqual(res.status, 403);
  });
});
