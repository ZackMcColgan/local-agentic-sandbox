import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  createExplorerWorker,
  createCriticWorker,
  type WorkspaceRepoMap
} from "../lib/subagents/workerPool";
import {
  Planner,
  generatePlanSpec,
  type PlanSpec
} from "../lib/subagents/planner";
import type { Milestone } from "../lib/subagents/types";

describe("Sprint A3 — Real ExplorerWorker Repo-Map Indexer, Multi-File Planner & Chunked Diff Critic", () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-test-"));
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Task 1: Real ExplorerWorker.exploreWorkspace & WorkspaceRepoMap", () => {
    it("scans workspace directory and extracts exported TypeScript symbols", async () => {
      // Create mock project files
      const srcDir = path.join(tmpDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, "auth.ts"),
        `export function loginUser(email: string): boolean { return true; }
export class SessionManager {
  token: string = "";
}
export interface UserProfile {
  id: string;
  name: string;
}
export const DEFAULT_TIMEOUT = 5000;
function internalHelper() {}`
      );

      fs.writeFileSync(
        path.join(srcDir, "utils.ts"),
        `export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const formatCurrency = (amount: number) => "$" + amount.toFixed(2);`
      );

      // Create ignored directories
      const nodeModules = path.join(tmpDir, "node_modules", "pkg");
      fs.mkdirSync(nodeModules, { recursive: true });
      fs.writeFileSync(path.join(nodeModules, "index.ts"), "export const ignored = true;");

      const explorer = createExplorerWorker();
      const repoMap: WorkspaceRepoMap = await explorer.exploreWorkspace({ path: tmpDir });

      assert.ok(repoMap, "exploreWorkspace must return a WorkspaceRepoMap");
      assert.ok(Array.isArray(repoMap.files), "repoMap must contain a files array");

      // Verify node_modules is ignored
      const ignoredFile = repoMap.files.find((f) => f.path.includes("node_modules"));
      assert.equal(ignoredFile, undefined, "node_modules must be excluded from repo map");

      // Verify auth.ts and its exported symbols
      const authFile = repoMap.files.find((f) => f.path.replace(/\\/g, "/").includes("src/auth.ts"));
      assert.ok(authFile, "auth.ts must be indexed in repo map");
      assert.ok(authFile.exports.includes("loginUser"), "must extract exported function loginUser");
      assert.ok(authFile.exports.includes("SessionManager"), "must extract exported class SessionManager");
      assert.ok(authFile.exports.includes("UserProfile"), "must extract exported interface UserProfile");
      assert.ok(authFile.exports.includes("DEFAULT_TIMEOUT"), "must extract exported const DEFAULT_TIMEOUT");
      assert.equal(authFile.exports.includes("internalHelper"), false, "must not extract non-exported symbol");

      // Verify utils.ts
      const utilsFile = repoMap.files.find((f) => f.path.replace(/\\/g, "/").includes("src/utils.ts"));
      assert.ok(utilsFile, "utils.ts must be indexed in repo map");
      assert.ok(utilsFile.exports.includes("Result"), "must extract exported type Result");
      assert.ok(utilsFile.exports.includes("formatCurrency"), "must extract exported const formatCurrency");

      // Verify formatted string representation contains summary
      if (repoMap.treeSummary) {
        assert.ok(repoMap.treeSummary.includes("src/auth.ts") || repoMap.treeSummary.includes("auth.ts"));
      }
    });
  });

  describe("Task 2: Inject WorkspaceRepoMap into Planner.generatePlan", () => {
    it("Planner.generatePlan is callable and accepts repoMap to target real files and test commands", async () => {
      let promptSent = "";
      const mockGenerate = async (opts: any) => {
        promptSent = opts.prompt;
        return {
          text: JSON.stringify({
            milestones: [
              {
                id: "M1",
                title: "Refactor auth module",
                description: "Update SessionManager to support token refresh",
                plannedFiles: ["src/auth.ts"],
                acceptanceCriteria: [
                  {
                    id: "AC-1",
                    assertion: "SessionManager has refreshToken method",
                    fileMatch: "src/auth.ts",
                    command: "npx tsx --test tests/auth.test.ts"
                  }
                ]
              }
            ]
          }),
          model: "swift-15-27b-mtp",
          loadDurationMs: 0
        };
      };

      const mockRepoMap: WorkspaceRepoMap = {
        root: tmpDir,
        files: [
          {
            path: "src/auth.ts",
            exports: ["loginUser", "SessionManager", "UserProfile"]
          }
        ],
        treeSummary: "src/auth.ts: loginUser, SessionManager, UserProfile"
      };

      // Call Planner.generatePlan with repoMap
      const plan = await Planner.generatePlan({
        taskId: "task-test-planner-01",
        goal: "Refactor SessionManager in auth.ts to add token refresh",
        generate: mockGenerate,
        repoMap: mockRepoMap
      });

      assert.ok(plan, "Planner.generatePlan must return PlanSpec");
      assert.ok(promptSent.includes("src/auth.ts"), "Planner prompt must include repo map file path");
      assert.ok(promptSent.includes("SessionManager"), "Planner prompt must include repo map symbol");
      assert.equal(plan.milestones.length, 1);
      assert.equal(plan.milestones[0].plannedFiles?.[0], "src/auth.ts");
      assert.equal(plan.milestones[0].acceptanceCriteria[0].command, "npx tsx --test tests/auth.test.ts");
    });
  });

  describe("Task 3: Upgrade CriticWorker.evaluateMilestoneDiff (num_predict: 2048 & chunked diff)", () => {
    it("uses num_predict: 2048 and evaluates diffs up to 16,000 characters", async () => {
      let numPredictPassed = 0;
      let diffLengthInPrompt = 0;

      const mockGenerate = async (opts: any) => {
        numPredictPassed = opts.options?.num_predict;
        diffLengthInPrompt = opts.prompt.length;
        return {
          text: JSON.stringify({
            approved: true,
            feedback: [],
            analysis: "Changes satisfy all criteria and pass tests."
          }),
          model: "swift-15-27b-mtp",
          loadDurationMs: 0
        };
      };

      const critic = createCriticWorker({
        generate: mockGenerate,
        model: "swift-15-27b-mtp"
      });

      const longDiff = "+\n".repeat(7000); // 14,000 chars

      const milestone: Milestone = {
        id: "M1",
        title: "Test long diff review",
        description: "Verify diff exceeding 6000 chars is not truncated at 6000",
        status: "in_progress",
        plannedFiles: ["large.ts"],
        acceptanceCriteria: [
          {
            id: "AC-1",
            assertion: "Large diff passes inspection"
          }
        ]
      };

      const result = await critic.evaluateMilestoneDiff(
        milestone,
        {
          diff: longDiff,
          testExitCode: 0,
          filesChanged: ["large.ts"]
        }
      );

      assert.equal(numPredictPassed, 2048, "CriticWorker must pass num_predict: 2048 to model");
      assert.ok(diffLengthInPrompt > 8000, `Critic prompt must accommodate diff > 6000 chars, got prompt length ${diffLengthInPrompt}`);
      assert.equal(result.approved, true);
    });

    it("evaluates alongside testRunner exit code and rejects when testExitCode !== 0", async () => {
      const mockGenerate = async () => ({
        text: JSON.stringify({ approved: true, feedback: [] }),
        model: "swift-15-27b-mtp",
        loadDurationMs: 0
      });

      const critic = createCriticWorker({
        generate: mockGenerate,
        model: "swift-15-27b-mtp"
      });

      const milestone: Milestone = {
        id: "M1",
        title: "Test failure review",
        description: "Milestone where tests failed",
        status: "in_progress",
        acceptanceCriteria: [
          {
            id: "AC-FAIL",
            assertion: "Must pass tests"
          }
        ]
      };

      const result = await critic.evaluateMilestoneDiff(
        milestone,
        {
          diff: "+ const passing = false;",
          testExitCode: 1,
          testOutput: "Error: Test assertion failed"
        }
      );

      assert.equal(result.approved, false, "Critic must reject when testExitCode !== 0");
      assert.ok(
        result.feedback.some((f) => f.includes("Test") || f.includes("test") || f.includes("exit")),
        "Critic feedback must reflect test failure"
      );
    });
  });
});
