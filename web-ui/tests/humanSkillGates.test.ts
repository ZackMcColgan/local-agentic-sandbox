import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { recordObservedPattern } from "../lib/subagents/skillGate.js";
import { GET, POST } from "../app/api/skills/route.js";
import { NextRequest } from "next/server";

describe("Sprint 3 — Human Skill Gates (/api/skills)", () => {
  it("gated skill promotion: lists pending candidates, approves candidate, and rejects candidate", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillgate-test-"));
    const originalSkillsDir = process.env.SKILLS_DIR;
    process.env.SKILLS_DIR = tmpDir;

    try {
      // 1. Record pattern 3 times to cross the gating threshold
      for (let i = 0; i < 3; i++) {
        recordObservedPattern("retry-jitter", {
          title: "Retry with Jitter",
          solutionSummary: "Use exponential backoff with full jitter"
        });
      }

      // 2. Call GET /api/skills
      const reqGet = new NextRequest("http://localhost:3000/api/skills");
      const resGet = await GET(reqGet);
      assert.equal(resGet.status, 200);
      const dataGet = await resGet.json();

      assert.equal(dataGet.pendingCount, 1);
      assert.equal(dataGet.pendingCandidates.length, 1);
      assert.equal(dataGet.pendingCandidates[0].id, "retry-jitter");
      assert.equal(dataGet.activeSkills.length, 0);

      // 3. Call POST /api/skills with action approve
      const reqApprove = new NextRequest("http://localhost:3000/api/skills", {
        method: "POST",
        body: JSON.stringify({ action: "approve", candidateId: "retry-jitter" })
      });
      const resApprove = await POST(reqApprove);
      assert.equal(resApprove.status, 200);
      const dataApprove = await resApprove.json();
      assert.equal(dataApprove.promoted, true);

      // Verify subsequent GET
      const resGet2 = await GET(reqGet);
      const dataGet2 = await resGet2.json();
      assert.equal(dataGet2.pendingCount, 0);
      assert.equal(dataGet2.activeSkills.length, 1);

      // 4. Record a second pattern 3 times, then reject it
      for (let i = 0; i < 3; i++) {
        recordObservedPattern("strict-eval", {
          title: "Strict Eval",
          solutionSummary: "Use safe eval alternative"
        });
      }

      const reqReject = new NextRequest("http://localhost:3000/api/skills", {
        method: "POST",
        body: JSON.stringify({ action: "reject", candidateId: "strict-eval" })
      });
      const resReject = await POST(reqReject);
      assert.equal(resReject.status, 200);
      const dataReject = await resReject.json();
      assert.equal(dataReject.rejected, true);

      const resGet3 = await GET(reqGet);
      const dataGet3 = await resGet3.json();
      assert.equal(dataGet3.pendingCount, 0);
    } finally {
      process.env.SKILLS_DIR = originalSkillsDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
