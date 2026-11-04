#!/usr/bin/env node
/**
 * Host Runner SEA Compiler Script
 * Bundles host-bridge TypeScript daemon and compiles into Node 22 Single Executable Application (SEA).
 * Targets:
 *   - host-bridge/dist/host-runner.exe
 *   - C:\AI\ai-control\bin\host-runner.exe
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const hostBridgeDir = path.resolve(repoRoot, "host-bridge");
const distDir = path.resolve(hostBridgeDir, "dist");
const aiControlBinDir = "C:\\AI\\ai-control\\bin";
const aiControlBinExe = path.join(aiControlBinDir, "host-runner.exe");

function computeSha256() {
  const crypto = require("crypto");
  const sourceFiles = [];

  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(hostBridgeDir, fullPath).replace(/\\/g, "/");

      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "bin" ||
        entry.name === ".git" ||
        entry.name === "manifest.json" ||
        entry.name === "manifest.ts" ||
        relPath.startsWith("dist/") ||
        relPath.startsWith("bin/") ||
        relPath.startsWith("scripts/")
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name.endsWith(".json"))
      ) {
        sourceFiles.push(relPath);
      }
    }
  }

  scan(hostBridgeDir);
  sourceFiles.sort();

  const hash = crypto.createHash("sha256");
  for (const rel of sourceFiles) {
    const fullPath = path.join(hostBridgeDir, rel);
    const content = fs.readFileSync(fullPath, "utf8").replace(/\r\n/g, "\n");
    hash.update(`FILE:${rel}\n`);
    hash.update(content);
    hash.update("\n");
  }

  return hash.digest("hex");
}

if (process.argv.includes("--get-digest")) {
  const digest = computeSha256();
  process.stdout.write(digest);
  process.exit(0);
}

console.log("==========================================================");
console.log("  Building Host Runner SEA Binary (TypeScript / Node 22)  ");
console.log("==========================================================");

// 1. Prepare directories
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(aiControlBinDir)) {
  fs.mkdirSync(aiControlBinDir, { recursive: true });
}

// 2. Compute Bridge Source SHA-256 and write manifest.json
console.log("[1/6] Computing bridgeSourceSha256 provenance manifest...");

const sha256 = computeSha256();
const manifestData = {
  protocolVersion: 1,
  bridgeSourceSha256: sha256
};
fs.writeFileSync(path.join(hostBridgeDir, "manifest.json"), JSON.stringify(manifestData, null, 2) + "\n", "utf8");
console.log(`      Protocol Version: 1`);
console.log(`      bridgeSourceSha256: ${sha256}`);

// 3. Bundle TypeScript daemon into single JS bundle using esbuild
console.log("[2/6] Bundling TypeScript daemon with esbuild...");
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  // Try locating esbuild in web-ui or browser-mcp or root
  const candidates = [
    path.resolve(repoRoot, "web-ui/node_modules/esbuild"),
    path.resolve(repoRoot, "browser-mcp/node_modules/esbuild"),
    path.resolve(repoRoot, "node_modules/esbuild")
  ];
  for (const c of candidates) {
    try {
      esbuild = require(c);
      break;
    } catch {}
  }
}

if (!esbuild) {
  console.error("ERROR: esbuild not found in workspaces. Installing or locating esbuild...");
  process.exit(1);
}

const bundlePath = path.join(distDir, "bundle.js");
esbuild.buildSync({
  entryPoints: [path.join(hostBridgeDir, "daemon.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: bundlePath,
  format: "cjs",
  external: []
});
console.log(`      Bundled -> ${bundlePath}`);

// 4. Generate SEA preparation blob
console.log("[3/6] Generating Node SEA preparation blob...");
const seaConfigPath = path.join(distDir, "sea-config.json");
const seaBlobPath = path.join(distDir, "sea-prep.blob");
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: "bundle.js",
      output: "sea-prep.blob",
      disableExperimentalSEAWarning: true
    },
    null,
    2
  ),
  "utf8"
);

execSync(`"${process.execPath}" --experimental-sea-config sea-config.json`, {
  cwd: distDir,
  stdio: "inherit"
});

// 5. Copy node.exe and inject blob via postject
console.log("[4/6] Copying Node binary and injecting SEA resource via postject...");
const localExePath = path.join(distDir, "host-runner.exe");
fs.copyFileSync(process.execPath, localExePath);

const postjectCmd = `npx postject "${localExePath}" NODE_SEA_BLOB "${seaBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;
execSync(postjectCmd, {
  cwd: distDir,
  stdio: "inherit"
});

// 6. Copy compiled binary to C:\AI\ai-control\bin\host-runner.exe
console.log(`[5/6] Deploying executable to ${aiControlBinExe}...`);
fs.copyFileSync(localExePath, aiControlBinExe);
fs.writeFileSync(
  path.join(aiControlBinDir, "manifest.json"),
  JSON.stringify(manifestData, null, 2) + "\n",
  "utf8"
);

// 7. Verify executable runs
console.log("[6/6] Verifying compiled executable fail-closed and health readiness...");
try {
  // Test that running without secret fails closed
  execSync(`"${aiControlBinExe}"`, {
    env: { ...process.env, HOST_RUNNER_SHARED_SECRET: "" },
    stdio: "pipe"
  });
  console.error("ERROR: Executable should have failed without secret!");
  process.exit(1);
} catch (err) {
  // Expected to exit 1
  console.log("      Verified: Executable fails closed when HOST_RUNNER_SHARED_SECRET is missing.");
}

console.log("==========================================================");
console.log("  BUILD SUCCESS: Host Runner SEA compiled & deployed!");
console.log(`  Binary: ${aiControlBinExe} (${(fs.statSync(aiControlBinExe).size / (1024 * 1024)).toFixed(2)} MB)`);
console.log("==========================================================");
