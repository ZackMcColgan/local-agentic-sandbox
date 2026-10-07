import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OvernightSupervisor } from "../lib/subagents/supervisor";
import { TaskManifest, Milestone } from "../lib/subagents/types";

describe("Browser-MCP Connectivity — Internet Egress & Failure Handling", () => {
  it("executes a worker step that calls search_web and succeeds with results", async () => {
    const supervisor = new OvernightSupervisor();
    const milestone: Milestone = {
      id: "M-browser-1",
      title: "Query documentation via browser-mcp search_web",
      dependencies: [],
      acceptanceCriteria: [{ id: "c1", assertion: "Retrieve SVG documentation from web" }],
      status: "pending"
    };

    const manifest: TaskManifest = {
      taskId: `task-browser-success-${Date.now()}`,
      goal: "Search web for SVG specification and render chart",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones: [milestone],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    supervisor.saveCheckpoint(manifest);

    // Mock worker step that calls search_web
    const stepExecutorWithBrowserMcp = async (m: Milestone, attempt: number) => {
      const query = "SVG path syntax documentation";
      const searchResults = [
        { title: "SVG Paths - W3C", url: "https://www.w3.org/TR/SVG/paths.html", snippet: "Path data specifies the outline of a shape." }
      ];

      return {
        status: "completed" as const,
        gitSha: "git-sha-browser-ok",
        diff: `+ // Results from search_web('${query}'):\n+ // ${searchResults[0].title}`,
        diffSummary: `Search results: ${searchResults[0].title}`,
        builderIterations: 1,
        criticRounds: 1
      };
    };

    const result = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: stepExecutorWithBrowserMcp });

    assert.equal(result.status, "completed");
    assert.equal(result.milestones[0].status, "completed");
    assert.ok(result.milestones[0].diffSummary?.includes("SVG Paths - W3C"));
  });

  it("surfaces browser-mcp failure and parks the task rather than leaving milestone stuck in pending", async () => {
    const supervisor = new OvernightSupervisor();
    const milestone: Milestone = {
      id: "M-browser-fail",
      title: "Fetch external weather API documentation",
      dependencies: [],
      acceptanceCriteria: [{ id: "c1", assertion: "Weather docs fetched" }],
      status: "pending"
    };

    const manifest: TaskManifest = {
      taskId: `task-browser-fail-${Date.now()}`,
      goal: "Fetch external weather docs",
      toolchain: "node:22",
      status: "active",
      currentMilestoneIndex: 0,
      milestones: [milestone],
      checkpoints: [],
      ambiguityFlags: [],
      journal: []
    };

    supervisor.saveCheckpoint(manifest);

    // Mock browser-mcp outage
    const stepExecutorWithFailingBrowser = async (m: Milestone, attempt: number) => {
      throw new Error("browser-mcp error: 502 Bad Gateway connecting to egress-mesh scraper");
    };

    const result = await supervisor.executeTaskWithRecovery(manifest, { stepExecutor: stepExecutorWithFailingBrowser });

    assert.equal(result.status, "parked", "Task must transition to parked when browser-mcp is unreachable");
    assert.notEqual(result.milestones[0].status, "pending", "Milestone must not remain stuck in pending");

    const crashJournals = result.journal.filter((j) => j.message.includes("502 Bad Gateway"));
    assert.ok(crashJournals.length > 0, "Browser-MCP failure must be recorded in task journal, not swallowed");
    assert.ok(result.parkedReason?.includes("M-browser-fail"), "Parked reason must reference failing milestone");
  });
});
