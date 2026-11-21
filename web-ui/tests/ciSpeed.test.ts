import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const ciYmlPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
const chaosYmlPath = path.join(repoRoot, ".github", "workflows", "chaos.yml");
const e2eDir = path.join(repoRoot, "web-ui", "tests", "e2e");

test("(a) PR Playwright job runs with a 3-way --shard matrix", () => {
  const ci = fs.readFileSync(ciYmlPath, "utf8");
  assert.match(ci, /shard:\s*\[1,\s*2,\s*3\]/, "ci.yml must define a 3-way shard matrix [1, 2, 3]");
  assert.match(
    ci,
    /--shard=\$\{\{\s*matrix\.shard\s*\}\}\/3/,
    "ci.yml Playwright command must pass --shard=${{ matrix.shard }}/3"
  );
  assert.match(
    ci,
    /playwright-report-shard-\$\{\{\s*matrix\.shard\s*\}\}/,
    "ci.yml must upload distinct shard report artifacts"
  );
});

test("(b) chaos.yml triggers only on push to develop and workflow_dispatch, never pull_request", () => {
  assert.ok(fs.existsSync(chaosYmlPath), "chaos.yml must exist");
  const chaos = fs.readFileSync(chaosYmlPath, "utf8");
  assert.ok(!/^\s*pull_request\s*:/m.test(chaos), "chaos.yml must never trigger on pull_request");
  assert.match(chaos, /^\s*push\s*:/m, "chaos.yml must trigger on push");
  assert.match(
    chaos,
    /branches:\s*\[\s*["']?develop["']?\s*\]/,
    "chaos.yml push must target develop"
  );
  assert.match(chaos, /^\s*workflow_dispatch\s*:/m, "chaos.yml must support workflow_dispatch");
  assert.match(chaos, /--grep\s+@chaos/, "chaos.yml must run npx playwright test --grep @chaos");
});

test("(c) every @chaos-tagged spec is excluded from the PR Playwright command", () => {
  const ci = fs.readFileSync(ciYmlPath, "utf8");
  assert.match(
    ci,
    /--grep-invert\s+@chaos/,
    "ci.yml PR Playwright command must exclude @chaos specs with --grep-invert @chaos"
  );
  const specFiles = fs.readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts"));
  const chaosSpecs = specFiles.filter((f) =>
    fs.readFileSync(path.join(e2eDir, f), "utf8").includes("@chaos")
  );
  assert.ok(chaosSpecs.length > 0, "at least one e2e spec must be tagged @chaos");
});

test("(d) every job in ci.yml carries a timeout-minutes", () => {
  const ci = fs.readFileSync(ciYmlPath, "utf8");
  const jobMatches = ci.match(/^    runs-on:\s*/gm) ?? [];
  const timeoutMatches = ci.match(/^    timeout-minutes:\s*\d+\s*$/gm) ?? [];
  assert.ok(
    jobMatches.length >= 5,
    `expected at least 5 jobs in ci.yml, found ${jobMatches.length}`
  );
  assert.equal(
    timeoutMatches.length,
    jobMatches.length,
    `every job in ci.yml (${jobMatches.length}) must have timeout-minutes (found ${timeoutMatches.length})`
  );
});
