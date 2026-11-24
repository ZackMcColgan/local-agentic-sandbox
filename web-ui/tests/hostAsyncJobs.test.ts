import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostServer } from "../../host-bridge/server";
import { issueApprovalToken } from "../../host-bridge/approvalToken";

const TEST_SECRET = "async-jobs-test-secret-0123456789abcdef";

// PowerShell is only available on Windows; CI runs ubuntu-24.04 where
// powershell.exe does not exist and spawn hangs indefinitely.
const POWERSHELL_AVAILABLE = process.platform === "win32";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-host-runner-secret": TEST_SECRET,
    "sec-fetch-mode": "cors",
    "content-type": "application/json",
    ...extra,
  };
}

type JobBody = {
  jobId: string;
  status: string;
  exitCode?: number;
  finishedAt: number;
  startedAt: number;
  timedOut?: boolean;
  error?: string;
  reason?: string;
  [key: string]: unknown;
};

async function pollUntil(
  base: string,
  jobId: string,
  predicate: (body: JobBody) => boolean,
  timeoutMs = 20000
): Promise<JobBody> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/jobs/${jobId}`, { headers: authHeaders() });
    const body = (await res.json()) as JobBody;
    if (predicate(body)) return body;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pollUntil timed out waiting for predicate on job ${jobId}`);
}

async function startServer(
  jobsDir: string
): Promise<{ srv: ReturnType<typeof createHostServer>; base: string }> {
  const srv = createHostServer({ port: 0, jobsDir });
  await srv.start();
  const addr = srv.server.address() as { port: number };
  return { srv, base: `http://127.0.0.1:${addr.port}` };
}

async function startJob(
  base: string,
  tool: string,
  args: Record<string, unknown>,
  approvalId?: string
): Promise<{ status: number; body: JobBody }> {
  const res = await fetch(`${base}/execute-async`, {
    method: "POST",
    headers: authHeaders(approvalId ? { "x-host-approval-id": approvalId } : {}),
    body: JSON.stringify({ tool, args }),
  });
  return { status: res.status, body: (await res.json()) as JobBody };
}

describe("Async host jobs (start / spool / status / timeout / orphan)", () => {
  let jobsDir: string;
  let tempDir: string;

  before(() => {
    process.env.HOST_RUNNER_SHARED_SECRET = TEST_SECRET;
    jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-jobs-"));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-jobs-target-"));
  });

  after(() => {
    delete process.env.HOST_RUNNER_SHARED_SECRET;
    try {
      fs.rmSync(jobsDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test(
    "start returns a job id immediately while the command still runs",
    { skip: !POWERSHELL_AVAILABLE },
    async () => {
      const { srv, base } = await startServer(jobsDir);
      try {
        const t0 = Date.now();
        const { status, body } = await startJob(base, "host_run_powershell", {
          command: "Start-Sleep -Seconds 4; Write-Output 'late-output'",
        });
        const elapsed = Date.now() - t0;
        assert.ok(status === 200 || status === 202, `start status=${status}`);
        assert.ok(body.jobId, "start must return a jobId");
        assert.ok(["pending", "running"].includes(body.status), `status=${body.status}`);
        assert.ok(elapsed < 1500, `start latency ${elapsed}ms must be immediate`);

        const done = await pollUntil(base, body.jobId, (b) => b.status === "done");
        assert.strictEqual(done.exitCode, 0);

        const out = await (
          await fetch(`${base}/jobs/${body.jobId}/output?offset=0`, {
            headers: authHeaders(),
          })
        ).json();
        assert.ok(out.chunk.includes("late-output"));
      } finally {
        await srv.stop();
      }
    }
  );

  test("spool offset reads return the right slices", { skip: !POWERSHELL_AVAILABLE }, async () => {
    const { srv, base } = await startServer(jobsDir);
    try {
      const { body } = await startJob(base, "host_run_powershell", {
        command: "Write-Output '0123456789'",
      });
      await pollUntil(base, body.jobId, (b) => b.status === "done");

      const read = async (offset: number, limit?: number) =>
        await (
          await fetch(
            `${base}/jobs/${body.jobId}/output?offset=${offset}${limit ? `&limit=${limit}` : ""}`,
            {
              headers: authHeaders(),
            }
          )
        ).json();

      const first = await read(0, 4);
      assert.strictEqual(first.chunk, "0123");
      assert.strictEqual(first.nextOffset, 4);

      const second = await read(4, 4);
      assert.strictEqual(second.chunk, "4567");
      assert.strictEqual(second.nextOffset, 8);

      const tail = await read(8);
      assert.ok(tail.chunk.startsWith("89"), `tail chunk=${JSON.stringify(tail.chunk)}`);
      assert.strictEqual(tail.nextOffset, 8 + tail.chunk.length);
      assert.strictEqual(tail.totalLength, first.totalLength);
    } finally {
      await srv.stop();
    }
  });

  test(
    "status polling transitions pending/running to done",
    { skip: !POWERSHELL_AVAILABLE },
    async () => {
      const { srv, base } = await startServer(jobsDir);
      try {
        const { body } = await startJob(base, "host_run_powershell", {
          command: "Start-Sleep -Seconds 2; Write-Output 'ok'",
        });
        assert.ok(["pending", "running"].includes(body.status));

        const running = await pollUntil(base, body.jobId, (b) => b.status === "running");
        assert.strictEqual(running.jobId, body.jobId);

        const done = await pollUntil(base, body.jobId, (b) => b.status === "done");
        assert.strictEqual(done.exitCode, 0);
        assert.ok(done.finishedAt >= done.startedAt);
      } finally {
        await srv.stop();
      }
    }
  );

  test(
    "job-level timeout kills and stamps a hung job (60-minute class)",
    { skip: !POWERSHELL_AVAILABLE },
    async () => {
      const { srv, base } = await startServer(jobsDir);
      try {
        // 60-minute class: the async path accepts timeouts up to 3600s.
        const big = await startJob(base, "host_run_powershell", {
          command: "Write-Output 'x'",
          timeoutSeconds: 3600,
        });
        assert.ok(big.status === 200 || big.status === 202, `3600s start status=${big.status}`);
        assert.ok(big.body.jobId);

        // Hung job with a short timeout must be killed and stamped failed+timedOut.
        const { body } = await startJob(base, "host_run_powershell", {
          command: "Start-Sleep -Seconds 60",
          timeoutSeconds: 2,
        });
        const failed = await pollUntil(base, body.jobId, (b) => b.status === "failed", 15000);
        assert.strictEqual(failed.timedOut, true);
        assert.ok(failed.error && /timed out/i.test(failed.error));
      } finally {
        await srv.stop();
      }
    }
  );

  test(
    "a job orphaned by a daemon restart reads as interrupted",
    { skip: !POWERSHELL_AVAILABLE },
    async () => {
      const { srv, base } = await startServer(jobsDir);
      const { body } = await startJob(base, "host_run_powershell", {
        command: "Start-Sleep -Seconds 30",
        timeoutSeconds: 300,
      });
      await pollUntil(base, body.jobId, (b) => b.status === "running");

      // Daemon restart: stop the server, start a fresh one over the same jobsDir.
      await srv.stop();
      const { srv: srv2, base: base2 } = await startServer(jobsDir);
      try {
        const status = await (
          await fetch(`${base2}/jobs/${body.jobId}`, { headers: authHeaders() })
        ).json();
        assert.strictEqual(status.status, "interrupted");
        const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, "jobs.json"), "utf8"));
        const rec = persisted.find((j: { id?: string; status?: string }) => j.id === body.jobId);
        assert.strictEqual(rec.status, "interrupted");
      } finally {
        await srv2.stop();
      }
    }
  );

  test(
    "the synchronous path still completes a short command inline",
    { skip: !POWERSHELL_AVAILABLE },
    async () => {
      const { srv, base } = await startServer(jobsDir);
      try {
        const res = await fetch(`${base}/execute`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            tool: "host_run_powershell",
            args: { command: "Write-Output 'inline-output'" },
          }),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.ok(body.output.includes("inline-output"));
      } finally {
        await srv.stop();
      }
    }
  );

  test("destructive command is classified and approval-gated at START with no execution before approval", async () => {
    const { srv, base } = await startServer(jobsDir);
    const victim = path.join(tempDir, "victim.txt");
    fs.writeFileSync(victim, "do not delete me", "utf8");
    try {
      // No approval header: rejected at START, nothing executed.
      const denied = await startJob(base, "host_delete_path", { path: victim });
      assert.strictEqual(denied.status, 403);
      assert.ok(denied.body.reason, "403 must carry the classifier reason");
      assert.ok(fs.existsSync(victim), "destructive job must not execute before approval");

      // Approved: job runs and deletes. Token bound to this exact tool + payload.
      const approvalToken = issueApprovalToken(TEST_SECRET, "host_delete_path", { path: victim });
      const started = await startJob(base, "host_delete_path", { path: victim }, approvalToken);
      assert.ok(started.status === 200 || started.status === 202);
      await pollUntil(
        base,
        started.body.jobId,
        (b) => b.status === "done" || b.status === "failed"
      );
      assert.ok(!fs.existsSync(victim), "approved destructive job must execute");

      // Replay of a consumed token is rejected (409) and does not execute.
      const replay = await startJob(base, "host_delete_path", { path: victim }, approvalToken);
      assert.strictEqual(replay.status, 409);
    } finally {
      await srv.stop();
    }
  });

  test("unknown job id reads as 404 and jobs require the shared secret", async () => {
    const { srv, base } = await startServer(jobsDir);
    try {
      const missing = await fetch(`${base}/jobs/nope-123`, { headers: authHeaders() });
      assert.strictEqual(missing.status, 404);

      const noSecret = await fetch(`${base}/execute-async`, {
        method: "POST",
        headers: { "sec-fetch-mode": "cors", "content-type": "application/json" },
        body: JSON.stringify({
          tool: "host_run_powershell",
          args: { command: "Write-Output 'x'" },
        }),
      });
      assert.strictEqual(noSecret.status, 401);
    } finally {
      await srv.stop();
    }
  });
});
