import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

describe("Phase 3 — Item 1 & 3: Deployment Configuration Suite", () => {
  function findRepoRoot(): string {
    const candidates = [
      process.cwd(),
      path.resolve(process.cwd(), ".."),
      path.resolve(process.cwd(), "../..")
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, "docker-compose.yml"))) {
        return dir;
      }
    }
    throw new Error(`Could not find repo root with docker-compose.yml in: ${candidates.join(", ")}`);
  }

  it("docker-compose.yml contains swift-27b-mtp and has zero stale model references", () => {
    const root = findRepoRoot();
    const composeContent = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");

    assert.ok(composeContent.includes("MODEL_NAME=swift-27b-mtp"), "docker-compose.yml must set MODEL_NAME=swift-27b-mtp");
    assert.equal(composeContent.includes("qwen3.8"), false, "docker-compose.yml must not contain qwen3.8");
    assert.equal(composeContent.includes("gemma4"), false, "docker-compose.yml must not contain gemma4");
    assert.equal(composeContent.includes("hermes3"), false, "docker-compose.yml must not contain hermes3");
  });

  it("docker-compose.yml binds web-ui to all interfaces (3001:3000, not 127.0.0.1:3001)", () => {
    const root = findRepoRoot();
    const composeContent = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");

    assert.ok(
      composeContent.includes('"3001:3000"') || composeContent.includes("- 3001:3000"),
      "docker-compose.yml must bind web-ui port 3001:3000 across all interfaces"
    );
    assert.equal(
      composeContent.includes("127.0.0.1:3001"),
      false,
      "docker-compose.yml must not restrict web-ui port to 127.0.0.1"
    );
  });

  it("Makefile contains swift-27b-mtp and has zero stale model references", () => {
    const root = findRepoRoot();
    const makefileContent = fs.readFileSync(path.join(root, "Makefile"), "utf8");

    assert.ok(makefileContent.includes("swift-27b-mtp"), "Makefile must reference swift-27b-mtp");
    assert.equal(makefileContent.includes("qwen3.8"), false, "Makefile must not contain qwen3.8");
    assert.equal(makefileContent.includes("gemma4"), false, "Makefile must not contain gemma4");
    assert.equal(makefileContent.includes("hermes3"), false, "Makefile must not contain hermes3");
  });
});
