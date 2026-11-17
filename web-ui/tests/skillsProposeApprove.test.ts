import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { GET as getSkills, POST as postSkills } from "../app/api/skills/route";

describe("Skills Propose & Approve API Flow & Thread Branch Hygiene", () => {
  let tempSkillsDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    process.env.SKILLS_DIR = tempSkillsDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(tempSkillsDir)) {
      fs.rmSync(tempSkillsDir, { recursive: true, force: true });
    }
  });

  describe("Task 1: POST /api/skills propose -> approve -> GET /api/skills flow", () => {
    it("proposes a candidate skill via POST /api/skills (candidateId, title, solutionSummary) and lists it in GET /api/skills pendingCandidates", async () => {
      const proposeReq = new Request("http://localhost:3000/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "propose",
          candidateId: "clamp-output-rule",
          title: "Always Clamp Tool Outputs",
          solutionSummary: "Enforce MAX_TOOL_OUTPUT_CHARS clamp across all tool executions."
        })
      });

      const proposeRes = await postSkills(proposeReq as any);
      assert.equal(proposeRes.status, 200);

      const proposeData = await proposeRes.json();
      assert.equal(proposeData.proposed, true);
      assert.equal(proposeData.candidateId, "clamp-output-rule");
      assert.equal(proposeData.isPendingApproval, true);
      assert.ok(proposeData.candidate);
      assert.equal(proposeData.candidate.title, "Always Clamp Tool Outputs");
      assert.ok(proposeData.candidate.occurrences >= 3);

      // Verify GET /api/skills includes this candidate in pendingCandidates
      const getReq = new Request("http://localhost:3000/api/skills");
      const getRes = await getSkills(getReq as any);
      assert.equal(getRes.status, 200);

      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.pendingCandidates));
      const foundPending = getData.pendingCandidates.find((c: any) => c.id === "clamp-output-rule");
      assert.ok(foundPending, "Proposed candidate must appear in GET /api/skills pendingCandidates");
      assert.equal(foundPending.title, "Always Clamp Tool Outputs");
    });

    it("supports slug, name, content payload aliases when proposing and slug alias when approving", async () => {
      const proposeReq = new Request("http://localhost:3000/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "propose",
          slug: "svg-self-contained-rule",
          name: "Inline Self-Contained SVG",
          content: "Always emit pure self-contained SVG elements inside svg code fences."
        })
      });

      const proposeRes = await postSkills(proposeReq as any);
      assert.equal(proposeRes.status, 200);
      const proposeData = await proposeRes.json();
      assert.equal(proposeData.proposed, true);
      assert.equal(proposeData.candidateId, "svg-self-contained-rule");
      assert.equal(proposeData.isPendingApproval, true);

      // Approve using slug
      const approveReq = new Request("http://localhost:3000/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          slug: "svg-self-contained-rule"
        })
      });

      const approveRes = await postSkills(approveReq as any);
      assert.equal(approveRes.status, 200);
      const approveData = await approveRes.json();
      assert.equal(approveData.promoted, true);
      assert.ok(approveData.skillPath);

      // Verify GET /api/skills lists the promoted skill file in activeSkills
      const getReq = new Request("http://localhost:3000/api/skills");
      const getRes = await getSkills(getReq as any);
      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.activeSkills));
      const foundActive = getData.activeSkills.some((s: string) => s.includes("svg-self-contained-rule"));
      assert.ok(foundActive, "Promoted skill file must appear in activeSkills list");
    });

    it("approves a proposed skill via POST /api/skills (action: 'approve') and creates the active skill file", async () => {
      // 1. Propose candidate
      await postSkills(
        new Request("http://localhost:3000/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "propose",
            candidateId: "strict-test-gate",
            title: "Strict Test Gate",
            solutionSummary: "Never bypass test gate."
          })
        }) as any
      );

      // 2. Approve candidate
      const approveReq = new Request("http://localhost:3000/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          candidateId: "strict-test-gate"
        })
      });

      const approveRes = await postSkills(approveReq as any);
      assert.equal(approveRes.status, 200);
      const approveData = await approveRes.json();
      assert.equal(approveData.promoted, true);
      assert.ok(approveData.skillPath);
      assert.ok(fs.existsSync(approveData.skillPath));

      // 3. Verify GET /api/skills reflects active skill
      const getRes = await getSkills(new Request("http://localhost:3000/api/skills") as any);
      const getData = await getRes.json();
      assert.ok(getData.activeSkills.some((s: string) => s.includes("strict-test-gate")));
    });

    it("returns 400 when action or identifier is missing", async () => {
      const resMissingAction = await postSkills(
        new Request("http://localhost:3000/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: "foo" })
        }) as any
      );
      assert.equal(resMissingAction.status, 400);

      const resMissingId = await postSkills(
        new Request("http://localhost:3000/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "propose" })
        }) as any
      );
      assert.equal(resMissingId.status, 400);
    });
  });

  describe("Task 2: web-ui/app/api/threads/route.ts branch name formatting", () => {
    it("strips leading 'task-' prefix so branch names are feat/task-1792... not feat/task-task-1792...", () => {
      const threadsRoutePath = path.resolve(__dirname, "../app/api/threads/route.ts");
      const content = fs.readFileSync(threadsRoutePath, "utf8");

      assert.ok(
        content.includes('taskId.replace(/^task-/, "")'),
        "threads/route.ts must strip leading task- from taskId when constructing branchName"
      );
      assert.ok(
        !content.includes("`feat/task-${taskId.slice(0, 12)}`"),
        "threads/route.ts must not use `feat/task-${taskId.slice(0, 12)}` which causes double task- prefix"
      );

      // Verify formatting logic directly
      const sampleTaskId = "task-1792225678718";
      const branchName = `feat/task-${sampleTaskId.replace(/^task-/, "").slice(0, 12)}`;
      assert.equal(branchName, "feat/task-179222567871");
      assert.ok(!branchName.startsWith("feat/task-task-"));
    });
  });
});
