import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

describe("Sprint 12 Phase 7 — Flywheel Skills Spike (flywheelSkills.test.ts)", () => {
  it("extracts reusable patterns from a completed task and saves them to SQLite skills table", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const {
        FlywheelSkillsStore,
        extractSkillsFromCompletedTask
      } = await import("../lib/flywheel/skillsStore.js");

      const store = new FlywheelSkillsStore(dbPath);

      const completedTask = {
        taskId: "task-svg-101",
        goal: "Create a weather forecast SVG card with icons and temperature badge",
        toolchain: "node:22" as const,
        status: "completed" as const,
        branchName: "feature/weather-svg",
        milestones: [
          {
            id: "M1",
            title: "Build weather SVG vector card",
            description: "Generate standalone valid SVG with viewBox 0 0 800 600",
            status: "completed" as const,
            builderIterations: 1,
            criticRounds: 1,
            plannedFiles: ["weather.svg"],
            diffSummary: `+<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">\n+<rect width="800" height="600" rx="24" fill="#0f172a"/>\n+</svg>`,
            acceptanceCriteria: []
          }
        ],
        currentMilestoneIndex: 1,
        checkpoints: [],
        ambiguityFlags: [],
        journal: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const extractedSkills = extractSkillsFromCompletedTask(completedTask);
      assert.ok(extractedSkills.length > 0, "Must extract at least 1 pattern from completed SVG task");
      assert.equal(extractedSkills[0].domain, "svg");

      store.saveSkills(extractedSkills);

      const allSkills = store.listSkills();
      assert.equal(allSkills.length, extractedSkills.length);
      assert.equal(allSkills[0].sourceTaskId, "task-svg-101");

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("retrieves relevant skills matching subsequent planner goals and ignores irrelevant skills", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-retrieval-test-"));
    const dbPath = path.join(tmpDir, "runs.db");

    try {
      const { FlywheelSkillsStore } = await import("../lib/flywheel/skillsStore.js");
      const store = new FlywheelSkillsStore(dbPath);

      store.saveSkills([
        {
          skillId: "skill-svg-card",
          name: "SVG Card Layout",
          description: "Structured SVG canvas with viewBox and rounded corner background",
          domain: "svg",
          patternTemplate: "<svg viewBox=\"0 0 800 600\">\n  <rect rx=\"24\" />\n</svg>",
          sourceTaskId: "task-prior-1",
          confidenceScore: 0.95,
          createdAt: new Date().toISOString(),
          useCount: 0
        },
        {
          skillId: "skill-k8s-nodeport",
          name: "Kubernetes Ephemeral NodePort",
          description: "Service exposition on non-colliding port range 30100-32767",
          domain: "k8s",
          patternTemplate: "apiVersion: v1\nkind: Service\nspec:\n  type: NodePort",
          sourceTaskId: "task-prior-2",
          confidenceScore: 0.9,
          createdAt: new Date().toISOString(),
          useCount: 0
        }
      ]);

      // Query for an SVG task
      const svgMatches = store.retrieveRelevantSkills("Design an SVG architecture diagram for cloud gateway");
      assert.ok(svgMatches.some((s) => s.skillId === "skill-svg-card"), "Must retrieve SVG pattern for SVG goal");
      assert.ok(!svgMatches.some((s) => s.skillId === "skill-k8s-nodeport"), "Must not retrieve K8s pattern for purely SVG goal");

      // Query for K8s task
      const k8sMatches = store.retrieveRelevantSkills("Deploy ephemeral cluster service in isolated namespace");
      assert.ok(k8sMatches.some((s) => s.skillId === "skill-k8s-nodeport"), "Must retrieve K8s pattern for deployment goal");

      store.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("formats relevant skills for planner context injection", async () => {
    const { formatSkillsForPlannerPrompt } = await import("../lib/flywheel/skillsStore.js");

    const formatted = formatSkillsForPlannerPrompt([
      {
        skillId: "skill-1",
        name: "Standard Next.js Route Handler",
        description: "Export GET and POST with NextResponse.json",
        domain: "nextjs",
        patternTemplate: "export async function GET(req: Request) { return NextResponse.json({ ok: true }); }",
        sourceTaskId: "task-prev",
        confidenceScore: 0.92,
        createdAt: new Date().toISOString(),
        useCount: 1
      }
    ]);

    assert.ok(formatted.includes("[REUSABLE PATTERNS FROM PAST SUCCESSFUL RUNS]"));
    assert.ok(formatted.includes("Standard Next.js Route Handler"));
    assert.ok(formatted.includes("NextResponse.json"));
  });
});
