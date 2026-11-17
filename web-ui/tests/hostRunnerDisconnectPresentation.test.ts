import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// @ts-ignore - resolved at test time
import { classifyHostRunnerDisconnect } from "../lib/liveActivity";

describe("UI-007: host-runner disconnect presentation", () => {
  it("classifies a message containing host-runner disconnect text as disconnected and strips bare text", () => {
    const res = classifyHostRunnerDisconnect(
      "Host runner daemon disconnected mid-turn: connection reset\nContinuing local checks."
    );
    assert.equal(res.kind, "disconnected");
    assert.ok(res.summary.length > 0);
    assert.doesNotMatch(res.remainingContent, /Host runner daemon disconnected mid-turn/);
    assert.match(res.remainingContent, /Continuing local checks\./);
  });

  it("classifies a disconnect followed by recovery as recovered", () => {
    const res = classifyHostRunnerDisconnect(
      "Host runner disconnected mid-watch: ECONNRESET\nHost runner reconnected."
    );
    assert.equal(res.kind, "recovered");
    assert.doesNotMatch(res.remainingContent, /Host runner disconnected mid-watch/);
  });

  it("returns none for normal assistant content", () => {
    const res = classifyHostRunnerDisconnect("All tests passed.");
    assert.equal(res.kind, "none");
    assert.equal(res.remainingContent, "All tests passed.");
  });

  it("ChatStream.tsx renders the distinct host-runner disconnect/recovered status element", () => {
    const chatSrc = fs.readFileSync(path.join(process.cwd(), "components/ChatStream.tsx"), "utf8");
    assert.match(chatSrc, /classifyHostRunnerDisconnect\s*\(/);
    assert.match(chatSrc, /host-runner-disconnect-status/);
  });
});
