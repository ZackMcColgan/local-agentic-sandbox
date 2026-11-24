/**
 * Build and containerd image import script (S2 only — NO kubectl / NO rollout).
 *
 * Usage:
 *   node scripts/build-import-image.js [web-ui|mcp-server|browser-mcp]
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const K8S_NODE = process.env.K8S_NODE || "desktop-control-plane";

function run(cmd, opts = {}) {
  console.log(`\x1b[36m▶ ${cmd}\x1b[0m`);
  return execSync(cmd, {
    cwd: opts.cwd || REPO_ROOT,
    stdio: opts.stdio || "inherit",
    encoding: "utf8",
  });
}

function getCommitSha(full = false) {
  try {
    const args = full ? "git rev-parse HEAD" : "git rev-parse --short HEAD";
    return execSync(args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return Date.now().toString(36);
  }
}

function resolveServiceSpec(serviceName, tag) {
  if (serviceName === "web-ui") {
    return {
      serviceName: "web-ui",
      imageName: `local-agentic-sandbox-web-ui:${tag}`,
      dockerfile: "web-ui/Dockerfile",
      deploymentName: "web-ui",
    };
  }
  if (serviceName === "mcp-server") {
    return {
      serviceName: "mcp-server",
      imageName: `local-agentic-sandbox-mcp-server:${tag}`,
      dockerfile: "mcp-server/Dockerfile",
      deploymentName: "mcp-runner",
    };
  }
  if (serviceName === "browser-mcp") {
    return {
      serviceName: "browser-mcp",
      imageName: `local-agentic-sandbox-browser-mcp:${tag}`,
      dockerfile: "browser-mcp/Dockerfile",
      deploymentName: "browser-mcp",
    };
  }
  throw new Error(`Unknown service: ${serviceName}. Supported: web-ui, mcp-server, browser-mcp`);
}

function buildAndImportService(serviceName, opts = {}) {
  const execFn = opts.run || run;
  const shortSha = opts.shortSha || getCommitSha(false);
  const fullSha = opts.fullSha || getCommitSha(true);
  const timestamp = opts.timestamp || Date.now().toString(36);
  const tag = opts.tag || `v-${shortSha}-${timestamp}`;
  const spec = resolveServiceSpec(serviceName, tag);

  console.log(`[1/2] Building Docker image ${spec.imageName}...`);
  const buildArgs = serviceName === "web-ui" ? `--build-arg DEPLOYED_COMMIT_SHA=${fullSha} ` : "";
  execFn(`docker build ${buildArgs}-t ${spec.imageName} -f ${spec.dockerfile} .`);

  console.log(`[2/2] Importing image into cluster containerd node (${K8S_NODE})...`);
  const tarPath = path.join(REPO_ROOT, `temp-${serviceName}-${timestamp}.tar`);
  try {
    execFn(`docker save ${spec.imageName} -o "${tarPath}"`);
    execFn(`docker exec ${K8S_NODE} mkdir -p /images`);
    execFn(`docker cp "${tarPath}" ${K8S_NODE}:/images/image.tar`);
    execFn(`docker exec ${K8S_NODE} ctr -n k8s.io images import /images/image.tar`);
    execFn(`docker exec ${K8S_NODE} rm -f /images/image.tar`);
  } finally {
    if (fs.existsSync(tarPath)) {
      try {
        fs.unlinkSync(tarPath);
      } catch {
        // Ignore temp tar cleanup error
      }
    }
  }

  console.log(`BUILT_IMAGE=${spec.imageName}`);
  return {
    serviceName: spec.serviceName,
    deploymentName: spec.deploymentName,
    imageName: spec.imageName,
    tag,
    commitSha: fullSha,
  };
}

if (require.main === module) {
  const target = process.argv[2] || "web-ui";
  try {
    buildAndImportService(target);
  } catch (err) {
    console.error(`\x1b[31mBuild/import failed: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

module.exports = {
  buildAndImportService,
  resolveServiceSpec,
};
