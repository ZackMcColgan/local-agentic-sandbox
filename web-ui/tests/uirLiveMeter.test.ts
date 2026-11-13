import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { ChatStream } from "../components/ChatStream";
import { latestRoundPromptTokens } from "../lib/tokenEconomics";
import { ThrottledStreamSnapshot, type StreamingSnapshotMessage } from "../lib/streamSnapshot";

// qa-7 / UI-013 — live header context meter (owner directive, Nov 12, 2026):
// the meter must show the LATEST ROUND'S ACTUAL prompt tokens, updating as
// rounds complete, visible on ANY watching client — not the turn-start
// estimate that only the initiating client's SSE stream ever sets (every
// other screen sat at 0K). The record carries per-round prompt tokens on
// assistant messages (roundPromptTokens); mid-turn snapshots must carry the
// array too, or watchers only learn the number when the turn settles.

describe("qa-7 helper — latestRoundPromptTokens", () => {
  it("returns the last entry of the most recent non-empty round array", () => {
    const v = latestRoundPromptTokens([
      { roundPromptTokens: [12000, 34000] },
      { roundPromptTokens: [34567] },
      {}
    ]);
    assert.equal(v, 34567);
  });

  it("scans past messages without data and ignores invalid entries", () => {
    const v = latestRoundPromptTokens([
      { roundPromptTokens: [0, -5, 22100] },
      { roundPromptTokens: [] },
      { role: "user" }
    ] as any);
    assert.equal(v, 22100);
  });

  it("returns 0 when no round data exists", () => {
    assert.equal(latestRoundPromptTokens([]), 0);
    assert.equal(latestRoundPromptTokens(undefined), 0);
    assert.equal(latestRoundPromptTokens([{ content: "hi" } as any]), 0);
  });
});

describe("qa-7 snapshot — round prompt tokens ride mid-turn snapshots", () => {
  it("snapshot writes carry roundPromptTokens and keep them on later writes", () => {
    const captured: StreamingSnapshotMessage[] = [];
    const sink = {
      addMessage: (_tid: string, msg: StreamingSnapshotMessage) => {
        captured.push(msg);
      }
    };
    let now = 100000;
    const snap = new ThrottledStreamSnapshot(sink as any, "thread-1", "assistant-1", 1000, () => now);
    const wrote1 = snap.maybeWrite("partial text", undefined, undefined, {
      roundPromptTokens: [12000, 34567]
    });
    assert.equal(wrote1, true);
    assert.deepEqual(captured[0].roundPromptTokens, [12000, 34567]);

    now += 5000;
    const wrote2 = snap.maybeWrite("more text", undefined, undefined, undefined);
    assert.equal(wrote2, true);
    assert.deepEqual(
      captured[1].roundPromptTokens,
      [12000, 34567],
      "later snapshots must not drop the round token record"
    );
  });
});

describe("qa-7 meter — ChatStream pill hydrates from the record", () => {
  function renderChat(messages: any[]) {
    return renderToString(
      React.createElement(ChatStream, {
        onTracesUpdate: () => {},
        activeModel: "qwen3.8-flash-next-gyro-gyro-s",
        reasoningEffort: "low",
        messages
      })
    );
  }

  it("pill shows the latest round's actual prompt tokens from messages", () => {
    const html = renderChat([
      { id: "u1", role: "user", content: "do the job" },
      { id: "a1", role: "assistant", content: "working", roundPromptTokens: [12000, 34567] }
    ]);
    assert.ok(html.includes('data-testid="context-meter-pill"'), "meter pill must render");
    assert.ok(
      html.includes("Context budget: 34567 /"),
      "pill must show the latest round's actual prompt tokens (34567), not 0"
    );
  });

  it("pill stays at 0 only when the record has no round data", () => {
    const html = renderChat([{ id: "u1", role: "user", content: "hello" }]);
    assert.ok(html.includes("Context budget: 0 /"), "no round data means an honest 0");
  });
});
