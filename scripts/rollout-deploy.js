/**
 * Host-side rollout, S4 health verification, automatic rollback, and persisted
 * deploy-record writer (S3 + S4). Designed to run detached on the host so it
 * survives web-ui pod termination under Recreate strategy.
 *
 * Usage:
 *   node scripts/rollout-deploy.js --service web-ui --image <imageRef> \
 *     [--rollback-image <prevRef>] [--record-path <path>] [--gateway-url <url>] [--detached]
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || "local-agentic-sandbox";
// Overall orchestration deadline: one S4 verification phase (kubectl rollout
// status --timeout=120s plus probes) must fit inside this budget; if it does
// not, the rollout aborts as "deadline exceeded" instead of starting a second
// unbounded phase (rollback) or hanging forever.
const ROLLOUT_DEADLINE_MS = 180_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--detached") {
      args.detached = true;
    } else if (token.startsWith("--") && i + 1 < argv.length) {
      args[token.slice(2)] = argv[++i];
    }
  }
  return args;
}

function writeRecordAtomically(recordPath, record) {
  if (!recordPath) return;
  const dir = path.dirname(recordPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.deploy-record.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmpPath, recordPath);
  } catch {
    fs.copyFileSync(tmpPath, recordPath);
    fs.unlinkSync(tmpPath);
  }
}

function runCmd(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
}

async function probeUrl(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch {
    return 0;
  }
}

async function verifyS4(deploymentName, gatewayUrl, opts = {}) {
  const execFn = opts.runCmd || runCmd;
  const probe = opts.probeUrl || probeUrl;
  let rolloutOk = false;
  try {
    execFn(
      `kubectl rollout status deployment/${deploymentName} -n ${K8S_NAMESPACE} --timeout=120s`
    );
    rolloutOk = true;
  } catch (err) {
    return {
      ok: false,
      rolloutSuccess: false,
      gatewayStatus: 0,
      threadsStatus: 0,
      failedStep: "rollout_status",
      observed: err instanceof Error ? err.message : String(err),
    };
  }

  if (deploymentName !== "web-ui" || !gatewayUrl) {
    return {
      ok: rolloutOk,
      rolloutSuccess: rolloutOk,
      gatewayStatus: 200,
      threadsStatus: 200,
    };
  }

  const base = gatewayUrl.replace(/\/$/, "");
  const gatewayStatus = await probe(`${base}/api/sandbox-status`);
  if (gatewayStatus !== 200) {
    return {
      ok: false,
      rolloutSuccess: rolloutOk,
      gatewayStatus,
      threadsStatus: 0,
      failedStep: "gateway_200",
      observed: `GET ${base}/api/sandbox-status returned ${gatewayStatus}`,
    };
  }

  const threadsStatus = await probe(`${base}/api/threads`);
  if (threadsStatus !== 200) {
    return {
      ok: false,
      rolloutSuccess: rolloutOk,
      gatewayStatus,
      threadsStatus,
      failedStep: "thread_list_loads",
      observed: `GET ${base}/api/threads returned ${threadsStatus}`,
    };
  }

  return {
    ok: true,
    rolloutSuccess: true,
    gatewayStatus,
    threadsStatus,
  };
}

async function rolloutService(params, opts = {}) {
  const execFn = opts.runCmd || runCmd;
  const deploymentName =
    params.deploymentName ||
    (params.service === "mcp-server" ? "mcp-runner" : params.service || "web-ui");
  const containerName = deploymentName;
  const image = params.image;
  const rollbackImage = params.rollbackImage || "";
  const recordPath = params.recordPath || "";
  const gatewayUrl = params.gatewayUrl || "http://127.0.0.1:3001";
  const nowIso = () => new Date().toISOString();
  const startedAt = Date.now();
  const deadlineExceeded = () => Date.now() - startedAt > ROLLOUT_DEADLINE_MS;

  if (!image) {
    throw new Error("Missing required --image argument");
  }

  writeRecordAtomically(recordPath, {
    status: "rolling_out",
    targetImage: image,
    rollbackTarget: rollbackImage || null,
    suspended: false,
    updatedAt: nowIso(),
  });

  try {
    execFn(
      `kubectl set image deployment/${deploymentName} ${containerName}=${image} -n ${K8S_NAMESPACE}`
    );
  } catch (err) {
    const record = {
      status: "failed",
      targetImage: image,
      rollbackTarget: rollbackImage || null,
      suspended: false,
      reason: `S3 set-image failed: ${err instanceof Error ? err.message : String(err)}`,
      updatedAt: nowIso(),
    };
    writeRecordAtomically(recordPath, record);
    return record;
  }

  const s4 = await verifyS4(deploymentName, gatewayUrl, opts);
  if (s4.ok) {
    const record = {
      status: "deployed",
      targetImage: image,
      rollbackTarget: rollbackImage || null,
      suspended: false,
      s4Verdict: s4,
      updatedAt: nowIso(),
    };
    writeRecordAtomically(recordPath, record);
    return record;
  }

  // S4 failed: if the first verification already burned the whole deadline,
  // abort instead of starting a second unbounded phase.
  if (deadlineExceeded()) {
    const record = {
      status: "failed",
      targetImage: image,
      rollbackTarget: rollbackImage || null,
      suspended: true,
      suspendedReason: `deadline exceeded: rollout verification did not finish within ${ROLLOUT_DEADLINE_MS}ms (failed step: ${s4.failedStep})`,
      suspendedAt: nowIso(),
      s4Verdict: s4,
      updatedAt: nowIso(),
    };
    writeRecordAtomically(recordPath, record);
    return record;
  }

  // S4 failed: automatically roll back to banked target and persist suspension flag
  let rollbackVerified = false;
  if (rollbackImage) {
    try {
      execFn(
        `kubectl set image deployment/${deploymentName} ${containerName}=${rollbackImage} -n ${K8S_NAMESPACE}`
      );
      const rbVerify = await verifyS4(deploymentName, gatewayUrl, opts);
      rollbackVerified = rbVerify.ok;
    } catch {
      rollbackVerified = false;
    }
  }

  const record = {
    status: "rolled_back_suspended",
    targetImage: image,
    rollbackTarget: rollbackImage || null,
    rollbackVerified,
    suspended: true,
    suspendedReason: `S4 verification failed at ${s4.failedStep}: ${s4.observed}`,
    suspendedAt: nowIso(),
    s4Verdict: s4,
    updatedAt: nowIso(),
  };
  writeRecordAtomically(recordPath, record);
  return record;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.detached) {
    const childArgs = process.argv.slice(2).filter((a) => a !== "--detached");
    const child = spawn(process.execPath, [__filename, ...childArgs], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log(`DETACHED_ROLLOUT_PID=${child.pid}`);
    process.exit(0);
  }

  rolloutService({
    service: args.service || "web-ui",
    image: args.image,
    rollbackImage: args["rollback-image"] || "",
    recordPath: args["record-path"] || "",
    gatewayUrl: args["gateway-url"] || "http://127.0.0.1:3001",
  })
    .then((record) => {
      console.log(JSON.stringify(record));
      if (record.status !== "deployed") {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`Rollout failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  rolloutService,
  verifyS4,
  writeRecordAtomically,
};
