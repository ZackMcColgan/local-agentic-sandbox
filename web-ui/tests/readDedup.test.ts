import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  READ_DEDUP_TOOLS,
  computeContentHash,
  extractReadPath,
  extractReadContent,
  buildReadDedupStub,
  ReadDedupRegistry,
  type ReadDedupMeta
} from "../lib/readDedup";

/**
 * TOKEN ECONOMICS PART (d): READ DEDUP.
 *
 * Within a thread, a file read whose path + content hash matches an earlier
 * read in the same thread returns a short stub referencing the earlier
 * trace/round instead of re-emitting the full content. A file whose content
 * changed re-reads normally (full content). The stub carries path + content
 * hash + the earlier trace/round reference so the read stays recoverable
 * from the thread record (the full result remains in ThreadMessage.traces).
 */

function filePayload(text: string): string {
  // Realistic read-result shape: content plus the metadata fields the read
  // tools actually return (total lines/bytes, paging state). Dedup hashes the
  // CONTENT payload only; the metadata inflates the payload so the stub is
  // meaningfully smaller than the full result, as in production.
  return JSON.stringify({
    success: true,
    path: "src/config.ts",
    content: text,
    total_lines: 201,
    total_bytes: text.length * 38,
    showing_lines: "1-201",
    has_more: false,
    next_start_line: null,
    truncated: false
  });
}

describe("Read dedup (d): constants and helpers", () => {
  it("the dedup tool set covers both sandbox and host file reads", () => {
    assert.ok(READ_DEDUP_TOOLS.includes("workspace_read_file"));
    assert.ok(READ_DEDUP_TOOLS.includes("host_read_file"));
  });

  it("computeContentHash is deterministic and content-sensitive", () => {
    const a = computeContentHash("hello world");
    assert.equal(a, computeContentHash("hello world"), "same content must hash identically");
    assert.notEqual(a, computeContentHash("hello world!"), "changed content must hash differently");
    assert.match(a, /^[0-9a-f]{16,}$/, "hash must be a hex digest");
  });

  it("extractReadPath recovers the path from read args", () => {
    assert.equal(extractReadPath({ path: "docs/runlog.md" }), "docs/runlog.md");
    assert.equal(extractReadPath({ file: "a/b.ts" }), "a/b.ts");
    assert.equal(extractReadPath({ filepath: "c.ts" }), "c.ts");
    assert.equal(extractReadPath({ command: "ls" }), null, "no path key means no dedup");
  });

  it("extractReadContent pulls the content payload out of both result shapes", () => {
    assert.equal(extractReadContent(filePayload("BODY")), "BODY");
    const mcpShape = JSON.stringify({ content: [{ type: "text", text: "BODY" }] });
    assert.equal(extractReadContent(mcpShape), "BODY");
  });
});

describe("Read dedup (d): first read full, unchanged re-read stub, changed re-read full", () => {
  it("the FIRST read of a path emits full content (never stubbed)", () => {
    const registry = new ReadDedupRegistry([]);
    const payload = filePayload("ORIGINAL");
    const decision = registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, payload, 1, 0);
    assert.equal(decision.deduplicated, false, "first read must not dedup");
    assert.ok(!decision.stub, "first read must carry no stub");
    assert.ok(decision.meta, "first read must be recorded in the registry");
    assert.equal(decision.meta!.path, "src/config.ts");
    assert.equal(decision.meta!.contentHash, computeContentHash("ORIGINAL"));
  });

  it("an UNCHANGED re-read of the same path returns a stub referencing the earlier trace/round", () => {
    const registry = new ReadDedupRegistry([]);
    const payload = filePayload("ORIGINAL");
    registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, payload, 1, 0);

    const second = registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, payload, 4, 7);
    assert.equal(second.deduplicated, true, "unchanged re-read must dedup");
    assert.ok(second.stub, "the dedup decision must carry a stub");
    assert.ok(second.stub!.startsWith("[Read dedup:"), "the stub must be self-describing");
    assert.ok(second.stub!.length < payload.length, "the stub must be shorter than the full content");
    assert.match(second.stub!, /path=src\/config\.ts/, "stub must carry the path");
    assert.match(second.stub!, /contentHash=[0-9a-f]+/, "stub must carry the content hash");
    assert.match(second.stub!, /firstReadRound=1/, "stub must reference the earlier round");
    assert.match(second.stub!, /firstReadTrace=0/, "stub must reference the earlier trace index");
    assert.equal(second.meta!.round, 1, "the reference must stay the FIRST read's round, not the re-read's");
    assert.match(second.stub!, /thread trace record/, "stub must point at the recoverable audit copy");
  });

  it("a CHANGED re-read of the same path emits full content and re-anchors the registry", () => {
    const registry = new ReadDedupRegistry([]);
    registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, filePayload("V1"), 1, 0);

    const changed = registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, filePayload("V2"), 3, 5);
    assert.equal(changed.deduplicated, false, "changed content must re-read normally (full)");
    assert.ok(!changed.stub);
    assert.equal(changed.meta!.contentHash, computeContentHash("V2"), "registry must re-anchor to the new hash");
    assert.equal(changed.meta!.round, 3, "registry must re-anchor to the new round/trace");

    // A later read identical to V2 dedups against the changed read, not V1.
    const again = registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, filePayload("V2"), 6, 9);
    assert.equal(again.deduplicated, true);
    assert.match(again.stub!, /firstReadRound=3/);
    assert.match(again.stub!, /firstReadTrace=5/);
  });

  it("dedup is keyed on path + hash together: same content under a different path is not stubbed", () => {
    const registry = new ReadDedupRegistry([]);
    const payload = filePayload("SAME");
    registry.checkAndRecord("workspace_read_file", { path: "src/a.ts" }, payload, 1, 0);
    const other = registry.checkAndRecord("workspace_read_file", { path: "src/b.ts" }, payload, 2, 1);
    assert.equal(other.deduplicated, false, "a different path must emit full content");
  });

  it("reads without a recoverable path are never deduped", () => {
    const registry = new ReadDedupRegistry([]);
    const decision = registry.checkAndRecord("workspace_run_command", { command: "ls" }, "OUTPUT", 1, 0);
    assert.equal(decision.deduplicated, false);
    assert.ok(!decision.meta, "non-path reads must not enter the registry");
  });
});

describe("Read dedup (d): cross-turn seeding from the thread record", () => {
  it("a read from an earlier turn seeds the registry so a same-thread re-read stubs against it", () => {
    const priorMessages = [
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "Read the config twice across turns." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "workspace_read_file", arguments: JSON.stringify({ path: "src/config.ts" }) }
          }
        ]
      },
      { role: "tool", name: "workspace_read_file", tool_call_id: "call_0", content: filePayload("ORIGINAL") }
    ];

    const registry = new ReadDedupRegistry(priorMessages);
    const decision = registry.checkAndRecord("workspace_read_file", { path: "src/config.ts" }, filePayload("ORIGINAL"), 1, 0);
    assert.equal(decision.deduplicated, true, "a re-read in a later turn must dedup against the earlier turn's read");
    assert.match(decision.stub!, /firstReadRound=1/, "reference must carry the earlier turn's round");
    assert.match(decision.stub!, /firstReadMessage=\d+/, "cross-turn reference must carry the earlier message index");
    assert.match(decision.stub!, /contentHash=[0-9a-f]+/);
  });
});

describe("Read dedup (d): stub metadata contract", () => {
  it("buildReadDedupStub renders path + hash + earlier trace/round verbatim", () => {
    const meta: ReadDedupMeta = {
      path: "docs/queue-steer-runlog.md",
      contentHash: computeContentHash("BODY"),
      round: 2,
      traceIndex: 3,
      originalChars: 85377
    };
    const stub = buildReadDedupStub(meta);
    assert.match(stub, /^\[Read dedup:/);
    assert.match(stub, /path=docs\/queue-steer-runlog\.md/);
    assert.match(stub, /contentHash=[0-9a-f]{16,}/);
    assert.match(stub, /firstReadRound=2/);
    assert.match(stub, /firstReadTrace=3/);
    assert.match(stub, /thread trace record/, "stub must state the read is recoverable from the thread record");
  });
});

describe("Read dedup (d): chat route wiring (source assertions)", () => {
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, "../app/api/chat/route.ts"),
    "utf8"
  );
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, "../lib/threads/threadStore.ts"),
    "utf8"
  );

  it("route imports lib/readDedup and consults the registry at the file-read result push site", () => {
    assert.match(routeSrc, /from "@\/lib\/readDedup"/, "route must import lib/readDedup");
    assert.match(routeSrc, /\.checkAndRecord\(/, "route must consult the dedup registry per read result");
    assert.match(routeSrc, /ReadDedupRegistry/, "route must construct the per-turn registry");
  });

  it("route persists the dedup log on BOTH persist paths (aborted and final assistant message)", () => {
    assert.match(routeSrc, /turnReadDedups/, "route must accumulate dedup metadata for the turn");
    const persistSites = routeSrc.match(/readDedups:/g) || [];
    assert.ok(persistSites.length >= 2, "dedup log must ride on both the aborted and final persist paths");
  });

  it("threadStore declares the readDedups field so the dedup log lands on the thread record", () => {
    assert.match(storeSrc, /readDedups\?:/, "ThreadMessage must carry the dedup audit field");
    assert.match(storeSrc, /ReadDedupMeta/, "threadStore must import the dedup metadata type");
  });
});
