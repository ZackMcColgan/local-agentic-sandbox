/**
 * Automated build, container import, and deployment wrapper for the local
 * Kubernetes (kind/docker-desktop) cluster.
 *
 * Delegates build+import to scripts/build-import-image.js (no kubectl) and
 * rollout+verification to scripts/rollout-deploy.js.
 *
 * Usage:
 *   node scripts/deploy-cluster.js [service]
 *   npm run deploy:cluster
 */

const { buildAndImportService } = require("./build-import-image");
const { rolloutService } = require("./rollout-deploy");

async function deployService(serviceName) {
  console.log(`\n\x1b[32m========================================================\x1b[0m`);
  console.log(`\x1b[32m🚀 Deploying ${serviceName} to Kubernetes\x1b[0m`);
  console.log(`\x1b[32m========================================================\x1b[0m\n`);

  const built = buildAndImportService(serviceName);
  const record = await rolloutService({
    service: built.serviceName,
    deploymentName: built.deploymentName,
    image: built.imageName,
    gatewayUrl: serviceName === "web-ui" ? process.env.DEPLOY_URL || "" : "",
  });

  if (record.status !== "deployed") {
    throw new Error(record.reason || record.suspendedReason || `Rollout failed (${record.status})`);
  }

  console.log(
    `\n\x1b[32m✔ ${serviceName} (${built.imageName}) is live and healthy in the cluster!\x1b[0m\n`
  );
}

async function main() {
  const target = process.argv[2] || "web-ui";
  try {
    if (target === "all") {
      await deployService("mcp-server");
      await deployService("browser-mcp");
      await deployService("web-ui");
    } else {
      await deployService(target);
    }
  } catch (err) {
    console.error(`\x1b[31mDeployment failed: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

main();
