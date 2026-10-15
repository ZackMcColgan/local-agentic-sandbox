/**
 * Automated build, container import, and zero-downtime deployment script
 * for the local Kubernetes (kind/docker-desktop) cluster.
 *
 * Why this exists:
 * The cluster runs on a containerized control plane node ('desktop-control-plane')
 * using internal containerd storage. Docker daemon builds on the Windows host
 * are not automatically visible to the Kubernetes node unless explicitly transferred.
 *
 * Usage:
 *   node scripts/deploy-cluster.js [service]
 *   npm run deploy:cluster
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const K8S_NODE = 'desktop-control-plane';
const K8S_NAMESPACE = 'local-agentic-sandbox';

function run(cmd, opts = {}) {
  console.log(`\x1b[36m▶ ${cmd}\x1b[0m`);
  return execSync(cmd, {
    cwd: opts.cwd || REPO_ROOT,
    stdio: opts.stdio || 'inherit',
    encoding: 'utf8'
  });
}

function getCommitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return Date.now().toString(36);
  }
}

async function deployService(serviceName) {
  const sha = getCommitSha();
  const timestamp = Date.now().toString(36);
  const tag = `v-${sha}-${timestamp}`;

  console.log(`\n\x1b[32m========================================================\x1b[0m`);
  console.log(`\x1b[32m🚀 Deploying ${serviceName} to Kubernetes [tag: ${tag}]\x1b[0m`);
  console.log(`\x1b[32m========================================================\x1b[0m\n`);

  let imageName = '';
  let dockerfile = '';
  let deploymentName = '';

  if (serviceName === 'web-ui') {
    imageName = `local-agentic-sandbox-web-ui:${tag}`;
    dockerfile = 'web-ui/Dockerfile';
    deploymentName = 'web-ui';
  } else if (serviceName === 'mcp-server') {
    imageName = `local-agentic-sandbox-mcp-server:${tag}`;
    dockerfile = 'mcp-server/Dockerfile';
    deploymentName = 'mcp-runner';
  } else if (serviceName === 'browser-mcp') {
    imageName = `local-agentic-sandbox-browser-mcp:${tag}`;
    dockerfile = 'browser-mcp/Dockerfile';
    deploymentName = 'browser-mcp';
  } else {
    throw new Error(`Unknown service: ${serviceName}. Supported: web-ui, mcp-server, browser-mcp`);
  }

  // 1. Build Docker image on host
  console.log(`[1/4] Building Docker image ${imageName}...`);
  run(`docker build -t ${imageName} -f ${dockerfile} .`);

  // 2. Export tar & copy directly into k8s node container
  console.log(`[2/4] Transferring image into cluster containerd node (${K8S_NODE})...`);
  const tarPath = path.join(REPO_ROOT, `temp-${serviceName}-${timestamp}.tar`);
  try {
    run(`docker save ${imageName} -o "${tarPath}"`);
    run(`docker exec ${K8S_NODE} mkdir -p /images`);
    run(`docker cp "${tarPath}" ${K8S_NODE}:/images/image.tar`);
    run(`docker exec ${K8S_NODE} ctr -n k8s.io images import /images/image.tar`);
    run(`docker exec ${K8S_NODE} rm -f /images/image.tar`);
  } finally {
    if (fs.existsSync(tarPath)) {
      try { fs.unlinkSync(tarPath); } catch {}
    }
  }

  // 3. Update Kubernetes deployment image
  console.log(`[3/4] Updating Kubernetes deployment/${deploymentName} image...`);
  run(`kubectl set image deployment/${deploymentName} ${deploymentName}=${imageName} -n ${K8S_NAMESPACE}`);

  // 4. Wait for rollout completion
  console.log(`[4/4] Awaiting deployment rollout status...`);
  run(`kubectl rollout status deployment/${deploymentName} -n ${K8S_NAMESPACE} --timeout=90s`);

  console.log(`\n\x1b[32m✔ ${serviceName} is live and healthy in the cluster!\x1b[0m\n`);
}

async function main() {
  const target = process.argv[2] || 'web-ui';
  try {
    if (target === 'all') {
      await deployService('mcp-server');
      await deployService('browser-mcp');
      await deployService('web-ui');
    } else {
      await deployService(target);
    }
  } catch (err) {
    console.error(`\x1b[31mDeployment failed: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

main();
