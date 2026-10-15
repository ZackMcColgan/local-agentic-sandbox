import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createCriticWorker } from "../lib/subagents/workerPool.js";
import { Milestone, AssertionContract } from "../lib/subagents/types.js";
import {
  checkOllama,
  enableOllamaMock,
  disableOllamaMock,
  logServiceMode
} from "./helpers/serviceMocks.js";

describe("Phase 2 — Item 3: Deliverable Contracts Suite", () => {

  let useRealOllama = false;

  before(async () => {
    useRealOllama = await checkOllama();
    logServiceMode("ollama", useRealOllama);
    if (!useRealOllama) enableOllamaMock();
  });

  after(() => {
    if (!useRealOllama) disableOllamaMock();
  });
  const tmpDir = path.resolve(process.cwd(), "temp-test-contracts");

  it("Milestone with 3 assertions, builder satisfies all 3 → approved", async () => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const targetFile = path.join(tmpDir, "service.ts");
      fs.writeFileSync(targetFile, "export const PORT = 8080;\nexport const TIMEOUT = 5000;", "utf8");

      const milestone: Milestone = {
        id: "M-CONTRACT-1",
        title: "Microservice Port Configuration",
        description: "Configure service port and timeouts",
        status: "in_progress",
        builderIterations: 1,
        criticRounds: 0,
        acceptanceCriteria: [],
        assertions: [
          {
            type: "file_exists",
            target: targetFile,
            description: "Service configuration file must exist"
          },
          {
            type: "output_contains",
            target: targetFile,
            expected: "PORT = 8080",
            description: "Must bind to port 8080"
          },
          {
            type: "no_hardcoded_values",
            target: targetFile,
            expected: "PORT = 3000",
            description: "Must not contain default port 3000"
          }
        ]
      };

      const critic = createCriticWorker();
      const review = await critic.evaluateMilestoneDiff(milestone, {
        diff: `+ export const PORT = 8080;\n+ export const TIMEOUT = 5000;`,
        filesChanged: [targetFile]
      });

      assert.equal(review.approved, true, "All 3 assertions satisfied must approve");
      assert.ok(review.assertions && review.assertions.length === 3);
      assert.ok(review.assertions.every((a) => a.passed));
    } finally {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Milestone with 3 assertions, builder fails 1 → rejected with specific failed assertion identified", async () => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const targetFile = path.join(tmpDir, "service.ts");
      fs.writeFileSync(targetFile, "export const PORT = 8080;", "utf8");

      const milestone: Milestone = {
        id: "M-CONTRACT-2",
        title: "Timeout assertion failure",
        description: "Require timeout config",
        status: "in_progress",
        builderIterations: 1,
        criticRounds: 0,
        acceptanceCriteria: [],
        assertions: [
          {
            type: "file_exists",
            target: targetFile,
            description: "File exists"
          },
          {
            type: "output_contains",
            target: targetFile,
            expected: "PORT = 8080",
            description: "Has port"
          },
          {
            type: "output_contains",
            target: targetFile,
            expected: "TIMEOUT = 5000",
            description: "Must have timeout"
          }
        ]
      };

      const critic = createCriticWorker();
      const review = await critic.evaluateMilestoneDiff(milestone, {
        diff: `+ export const PORT = 8080;`,
        filesChanged: [targetFile]
      });

      assert.equal(review.approved, false, "Failing 1 assertion must reject");
      assert.ok(review.assertions);
      const failed = review.assertions.find((a) => !a.passed);
      assert.ok(failed, "Failed assertion must be identified");
      assert.equal(failed?.assertion.expected, "TIMEOUT = 5000");
      assert.ok(review.feedback.some((f) => f.includes("TIMEOUT = 5000")));
    } finally {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Milestone with no assertions → falls back to legacy checks", async () => {
    const milestone: Milestone = {
      id: "M-LEGACY",
      title: "Legacy criteria verification",
      description: "Ensure egress-mesh is configured",
      status: "in_progress",
      builderIterations: 1,
      criticRounds: 0,
      acceptanceCriteria: [
        {
          id: "AC-LEGACY-1",
          assertion: "browser-mcp must be on egress-mesh network"
        }
      ]
    };

    const critic = createCriticWorker();
    const review = await critic.evaluateMilestoneDiff(milestone, {
      diff: "+ browser-mcp attached to egress-mesh"
    });

    assert.equal(review.approved, true, "Legacy check must pass with conforming criteria");
  });

  it("Assertion evidence includes the specific file/test/output that was checked", async () => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const targetFile = path.join(tmpDir, "config.json");
      fs.writeFileSync(targetFile, JSON.stringify({ active: true }), "utf8");

      const milestone: Milestone = {
        id: "M-EVIDENCE-CHECK",
        title: "Evidence extraction test",
        description: "Check evidence is recorded",
        status: "in_progress",
        builderIterations: 1,
        criticRounds: 0,
        acceptanceCriteria: [],
        assertions: [
          {
            type: "file_exists",
            target: targetFile,
            description: "Check config file exists"
          }
        ]
      };

      const critic = createCriticWorker();
      const review = await critic.evaluateMilestoneDiff(milestone, {
        diff: "+ {\"active\": true}",
        filesChanged: [targetFile]
      });

      assert.equal(review.approved, true);
      assert.ok(review.assertions && review.assertions[0].evidence);
      assert.ok(review.assertions[0].evidence.includes(targetFile));
    } finally {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
