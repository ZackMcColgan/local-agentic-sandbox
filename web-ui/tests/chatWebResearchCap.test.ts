import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  MAX_WEB_RESEARCH_CALLS,
  WEB_BUDGET_EXHAUSTED_DIRECTIVE,
  WEB_RESEARCH_TOOL_NAMES,
  filterToolsForWebBudget,
  canContinueToolLoop
} from "../lib/contextBudget.js";

describe("Item 2: Web Research Cap 100 per turn & Loop Continuation", () => {
  it("defines MAX_WEB_RESEARCH_CALLS = 100 as the single source of truth", () => {
    assert.equal(MAX_WEB_RESEARCH_CALLS, 100);
  });

  it("interpolates MAX_WEB_RESEARCH_CALLS into WEB_BUDGET_EXHAUSTED_DIRECTIVE without hardcoded 3", () => {
    assert.ok(
      WEB_BUDGET_EXHAUSTED_DIRECTIVE.includes("maximum of 100 web research calls"),
      "WEB_BUDGET_EXHAUSTED_DIRECTIVE must state 100 calls"
    );
    assert.ok(
      !WEB_BUDGET_EXHAUSTED_DIRECTIVE.includes("maximum of 3"),
      "WEB_BUDGET_EXHAUSTED_DIRECTIVE must not have stale 3"
    );
  });

  it("proves budget available at 3 and 99 calls, and exhausted at 100", () => {
    const sampleTools = [
      { function: { name: "search_web" } },
      { function: { name: "fetch_webpage_markdown" } },
      { function: { name: "workspace_write_file" } }
    ];

    // Calls = 3: still available
    const toolsAt3 = filterToolsForWebBudget(sampleTools, 3);
    assert.equal(toolsAt3.length, 3, "All tools available at 3 calls");

    // Calls = 99: still available
    const toolsAt99 = filterToolsForWebBudget(sampleTools, 99);
    assert.equal(toolsAt99.length, 3, "All tools available at 99 calls");

    // Calls = 100: exhausted
    const toolsAt100 = filterToolsForWebBudget(sampleTools, 100);
    assert.equal(toolsAt100.length, 1, "Web tools filtered out at 100 calls");
    assert.equal(toolsAt100[0].function.name, "workspace_write_file");
  });

  it("validates chat/route.ts system prompt and directives state 100 with no stale 'maximum 3' or 'typically 1-2' near-cap instructions", () => {
    const routePath = path.resolve(__dirname, "../app/api/chat/route.ts");
    const content = fs.readFileSync(routePath, "utf8");

    assert.ok(!content.includes("Maximum 3 web research"), "No 'Maximum 3' in route.ts");
    assert.ok(!content.includes("typically 1-2 searches"), "No 'typically 1-2 searches' near-cap in route.ts");
    assert.ok(
      content.includes("100 web research calls") || content.includes("${MAX_WEB_RESEARCH_CALLS} web research calls"),
      "route.ts prompt must reference 100 web research calls"
    );
  });

  it("canContinueToolLoop allows rounds beyond 8 only for exclusively web-research rounds within budget", () => {
    assert.equal(typeof canContinueToolLoop, "function", "canContinueToolLoop must be exported");

    // Round < 8: always continues
    assert.equal(canContinueToolLoop({ round: 0, maxToolRounds: 8, lastRoundTools: ["workspace_write_file"], webResearchCalls: 0 }), true);
    assert.equal(canContinueToolLoop({ round: 7, maxToolRounds: 8, lastRoundTools: ["workspace_write_file"], webResearchCalls: 0 }), true);

    // Round 8 with non-research tools in last round: strictly stops
    assert.equal(canContinueToolLoop({ round: 8, maxToolRounds: 8, lastRoundTools: ["workspace_write_file"], webResearchCalls: 5 }), false);
    assert.equal(canContinueToolLoop({ round: 8, maxToolRounds: 8, lastRoundTools: ["search_web", "workspace_write_file"], webResearchCalls: 5 }), false);

    // Round 8 with research-only tools in last round and webResearchCalls < 100: continues
    assert.equal(canContinueToolLoop({ round: 8, maxToolRounds: 8, lastRoundTools: ["search_web"], webResearchCalls: 8 }), true);
    assert.equal(canContinueToolLoop({ round: 15, maxToolRounds: 8, lastRoundTools: ["fetch_webpage_markdown"], webResearchCalls: 15 }), true);

    // Round 8+ when webResearchCalls >= 100: stops
    assert.equal(canContinueToolLoop({ round: 100, maxToolRounds: 8, lastRoundTools: ["search_web"], webResearchCalls: 100 }), false);
  });
});
