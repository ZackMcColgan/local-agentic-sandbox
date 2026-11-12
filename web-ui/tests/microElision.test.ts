import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MICRO_ELISION_RECENT_WINDOW,
  MICRO_ELISION_MIN_RESULT_CHARS,
  applyMicroElision,
  buildToolResultStub,
  type ElisionMeta
} from "../lib/microElision";
import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "../lib/contextBudget";

/**
 * TOKEN ECONOMICS PART (c): MICRO-ELISION OF TOOL RESULTS.
 *
 * Older tool results are stubbed in the prompt assembly path as soon as they
 * are superseded by newer rounds — WITHOUT waiting for the 85K fit trigger.
 * The most recent MICRO_ELISION_RECENT_WINDOW results stay byte-identical to
 * the un-elided content. Every stub preserves trace metadata (tool name,
 * path/command, original size, round number) so a stubbed result remains
 * identifiable and auditable in the thread record (the full result still
 * lives in ThreadMessage.traces).
 */

/** The 85% fit trigger the micro-elision must NOT wait for. */
const FIT_TRIGGER_TOKENS = Math.floor(CHAT_CONTEXT_BUDGET_TOKENS * 0.85);

function filler(chars: number): string {
  return "x".repeat(chars);
}

/**
 * Builds a conversation with `count` assistant+tool pairs. Each tool result is
 * `size` chars. Assistant messages carry tool_calls with the args so the
 * elision pass can recover the path/command target from the paired call.
 */
function buildToolConversation(count: number, size: number): any[] {
  const messages: any[] = [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: "Read a bunch of files and summarize." }
  ];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: {
            name: i % 2 === 0 ? "workspace_read_file" : "workspace_run_command",
            arguments: JSON.stringify(
              i % 2 === 0
                ? { path: `src/module-${i}.ts` }
                : { command: `npm run test:gate -- --since=round-${i}` }
            )
          }
        }
      ]
    });
    messages.push({
      role: "tool",
      name: i % 2 === 0 ? "workspace_read_file" : "workspace_run_command",
      tool_call_id: `call_${i}`,
      content: JSON.stringify({ success: true, output: filler(size) })
    });
  }
  return messages;
}

describe("Micro-elision (c): constants", () => {
  it("the recent window is a named constant pinned at 5 (the (b) fit-window experiment tunes it later)", () => {
    assert.equal(MICRO_ELISION_RECENT_WINDOW, 5, "standing default until part (b) tunes it");
    assert.ok(
      Number.isInteger(MICRO_ELISION_MIN_RESULT_CHARS) && MICRO_ELISION_MIN_RESULT_CHARS > 0,
      "a minimum-size guard must exist so tiny results are never stubbed"
    );
  });
});

describe("Micro-elision (c): stubbing superseded results below the fit trigger", () => {
  it("an old tool result is stubbed while the turn is still small (well under the 85K fit trigger)", () => {
    const messages = buildToolConversation(8, 6000);
    const tokens = estimateTokens(messages);
    assert.ok(tokens < FIT_TRIGGER_TOKENS, `fixture must sit far below the 85K trigger (got ${tokens})`);

    const { stubbed } = applyMicroElision(messages, 7);
    assert.ok(stubbed > 0, "superseded results must be stubbed even with no fit trigger fired");

    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.equal(stubbed, toolMsgs.length - MICRO_ELISION_RECENT_WINDOW, "only results past the recent window are stubbed");
    assert.ok(toolMsgs[0].elided === true, "the oldest result must be marked elided");
    assert.ok(toolMsgs[0].content.startsWith("[Micro-elision:"), "the stub must be self-describing");
  });

  it("results inside the recent window are byte-identical to the un-elided content", () => {
    const messages = buildToolConversation(8, 6000);
    const originals = messages.filter((m) => m.role === "tool").map((m) => m.content);

    applyMicroElision(messages, 7);

    const toolMsgs = messages.filter((m) => m.role === "tool");
    const kept = toolMsgs.slice(-MICRO_ELISION_RECENT_WINDOW);
    const keptOriginals = originals.slice(-MICRO_ELISION_RECENT_WINDOW);
    for (let i = 0; i < kept.length; i++) {
      assert.equal(kept[i].content, keptOriginals[i], `recent result ${i} must be byte-identical`);
      assert.ok(!kept[i].elided, "recent results must not be marked elided");
    }
  });

  it("results smaller than the minimum-size guard are never stubbed", () => {
    const messages = buildToolConversation(8, Math.floor(MICRO_ELISION_MIN_RESULT_CHARS / 2));
    const originals = messages.filter((m) => m.role === "tool").map((m) => m.content);
    const { stubbed } = applyMicroElision(messages, 7);
    assert.equal(stubbed, 0, "tiny results are kept full-size — stubbing them saves nothing");
    const toolMsgs = messages.filter((m) => m.role === "tool");
    toolMsgs.forEach((m, i) => assert.equal(m.content, originals[i]));
  });
});

describe("Micro-elision (c): stub metadata", () => {
  it("a stub carries tool + path + original size + round metadata", () => {
    const messages = buildToolConversation(6, 6000);
    applyMicroElision(messages, 6);
    const oldest = messages.find((m) => m.role === "tool" && m.elided) as any;
    assert.ok(oldest, "at least one stub must exist");
    assert.match(oldest.content, /tool=workspace_read_file/, "stub must name the tool");
    assert.match(oldest.content, /target=src\/module-0\.ts/, "stub must carry the path");
    assert.match(oldest.content, /originalChars=\d+/, "stub must carry the original size");
    assert.match(oldest.content, /round=\d+/, "stub must carry the round number");
    assert.equal(oldest.elidedFrom.tool, "workspace_read_file");
    assert.equal(oldest.elidedFrom.target, "src/module-0.ts");
    assert.equal(oldest.elidedFrom.targetKind, "path");
    assert.equal(oldest.elidedFrom.originalChars, oldest.elidedFrom.originalContent?.length ?? oldest.elidedFrom.originalChars);
    assert.ok(oldest.elidedFrom.originalChars > MICRO_ELISION_MIN_RESULT_CHARS, "recorded size must be the real original size");
    assert.ok(typeof oldest.elidedFrom.round === "number");
  });

  it("a stub for a command-bearing tool carries the command as the target", () => {
    const messages = buildToolConversation(6, 6000);
    applyMicroElision(messages, 6);
    const cmdStub = messages.find(
      (m) => m.role === "tool" && m.elided && m.name === "workspace_run_command"
    ) as any;
    assert.ok(cmdStub, "a command-bearing result must have been stubbed");
    assert.match(cmdStub.content, /tool=workspace_run_command/);
    assert.match(cmdStub.content, /target=npm run test:gate/, "stub must carry the command");
    assert.equal(cmdStub.elidedFrom.targetKind, "command");
  });

  it("buildToolResultStub renders the metadata fields verbatim", () => {
    const meta: ElisionMeta = {
      tool: "host_read_file",
      round: 4,
      target: "docs/queue-steer-runlog.md",
      targetKind: "path",
      originalChars: 83235
    };
    const stub = buildToolResultStub(meta);
    assert.match(stub, /^\[Micro-elision:/);
    assert.match(stub, /tool=host_read_file/);
    assert.match(stub, /round=4/);
    assert.match(stub, /target=docs\/queue-steer-runlog\.md/);
    assert.match(stub, /originalChars=83235/);
    assert.match(stub, /thread trace record/, "stub must point at the audit copy in the thread record");
  });
});

describe("Micro-elision (c): idempotence across rounds", () => {
  it("a stubbed result is never re-emitted full-size in a later round", () => {
    const messages = buildToolConversation(8, 6000);
    applyMicroElision(messages, 7);
    const stubContents = messages
      .filter((m) => m.role === "tool" && m.elided)
      .map((m) => m.content);
    assert.ok(stubContents.length > 0);

    // Later rounds: more results arrive, the window slides forward.
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_8", type: "function", function: { name: "workspace_read_file", arguments: JSON.stringify({ path: "src/module-8.ts" }) } }]
    });
    messages.push({
      role: "tool",
      name: "workspace_read_file",
      tool_call_id: "call_8",
      content: JSON.stringify({ success: true, output: filler(6000) })
    });
    applyMicroElision(messages, 8);

    for (const stub of stubContents) {
      const found = messages.find((m) => m.role === "tool" && m.content === stub);
      assert.ok(found, "an existing stub must survive later rounds unchanged (never restored to full size)");
      assert.ok(found.elided === true);
    }
  });

  it("changed underlying content is re-stubbed with fresh metadata, never emitted full-size", () => {
    const messages = buildToolConversation(6, 6000);
    applyMicroElision(messages, 6);
    const oldest = messages.find((m) => m.role === "tool" && m.elided) as any;
    assert.ok(oldest);

    // The underlying file changed (e.g. a re-read after an edit): the model
    // view gets the NEW full content; elision must stub it again with the new
    // size, never leave it full-size.
    const newContent = JSON.stringify({ success: true, output: filler(9000) });
    oldest.content = newContent;
    delete oldest.elided;
    delete oldest.elidedFrom;

    const { stubbed } = applyMicroElision(messages, 7);
    assert.ok(stubbed > 0);
    assert.ok(oldest.elided === true, "the changed result must be re-stubbed");
    assert.ok(oldest.content.startsWith("[Micro-elision:"), "the changed result must never be emitted full-size");
    assert.match(oldest.content, /originalChars=9\d{3}/, "fresh stub must carry the NEW size");
  });
});

describe("Micro-elision (c): chat route wiring (source assertions)", () => {
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, "../app/api/chat/route.ts"),
    "utf8"
  );

  it("route imports the micro-elision module and applies it per round, independent of the fit trigger", () => {
    assert.match(routeSrc, /from "@\/lib\/microElision"/, "route must import lib/microElision");
    assert.match(routeSrc, /applyMicroElision\(conversationMessages/, "route must elide the conversation before dispatch");
    // The elision call must NOT be gated on the compaction/fit branch: it runs
    // unconditionally at the round boundary.
    const elisionIdx = routeSrc.indexOf("applyMicroElision(conversationMessages");
    assert.ok(elisionIdx > 0);
    const window = routeSrc.slice(Math.max(0, elisionIdx - 400), elisionIdx + 200);
    assert.doesNotMatch(window, /if\s*\(\s*compaction\.compacted\s*\)/, "elision must not wait for the fit trigger");
  });
});
