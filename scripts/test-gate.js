#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const tsxCli = path.resolve(repoRoot, "web-ui/node_modules/tsx/dist/cli.mjs");
const script = path.resolve(repoRoot, "web-ui/scripts/test-gate.ts");
const args = [...process.argv.slice(2)];

// Handle PowerShell / cross-platform npm flag parsing where npm sets npm_config_* env vars
if (
  (process.env.npm_config_dry_run === "true" ||
    process.env.npm_config_dry_run === "" ||
    process.env.npm_config_dry_run === "1") &&
  !args.includes("--dry-run")
) {
  args.push("--dry-run");
}
if (process.env.npm_config_budget && !args.some((a) => a.startsWith("--budget="))) {
  args.push(`--budget=${process.env.npm_config_budget}`);
}
if (process.env.npm_config_since && !args.some((a) => a.startsWith("--since="))) {
  args.push(`--since=${process.env.npm_config_since}`);
}
if (process.env.npm_config_files && !args.some((a) => a.startsWith("--files="))) {
  args.push(`--files=${process.env.npm_config_files}`);
}
if (process.env.npm_config_all && !args.includes("--all")) {
  args.push("--all");
}

const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
  cwd: repoRoot,
  stdio: "inherit"
});

process.exit(result.status ?? (result.error ? 1 : 0));
