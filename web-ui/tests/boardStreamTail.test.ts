import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractJobOutcomeMetadata } from "../lib/board/boardOrchestrator";
import { createProductionIssueAndWait } from "../lib/board/productionDrain";
import {
  readResponseStreamTail,
  readStreamTail,
  STREAM_TAIL_CAP_BYTES,
} from "../lib/board/streamTail";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_UI_ROOT = path.resolve(TESTS_DIR, "..");

function makeChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test("oversized stream retains exact tail within cap and tracks full totalBytes", async () => {
  const cap = 1024;
  const prefix = "A".repeat(4096);
  const middle = "B".repeat(2048);
  const tailMarker = "TAIL_END_MARKER_1234567890";
  const fullPayload = prefix + middle + tailMarker;
  const expectedTail = fullPayload.slice(fullPayload.length - cap);

  const response = new Response(makeChunkedStream([prefix, middle, tailMarker]));
  const result = await readResponseStreamTail(response, cap);

  assert.equal(result.totalBytes, Buffer.byteLength(fullPayload, "utf8"));
  assert.ok(Buffer.byteLength(result.tail, "utf8") <= cap);
  assert.equal(result.tail, expectedTail);
});

test("default STREAM_TAIL_CAP_BYTES is 256 KiB and bounds oversized streams", async () => {
  assert.equal(STREAM_TAIL_CAP_BYTES, 256 * 1024);

  const chunk = "x".repeat(64 * 1024);
  const chunks = Array.from({ length: 6 }, () => chunk); // 384 KiB
  const marker = "\nFINAL_TAIL_MARKER\n";
  const response = new Response(makeChunkedStream([...chunks, marker]));

  const result = await readResponseStreamTail(response);
  const expectedTotal = 6 * 64 * 1024 + Buffer.byteLength(marker, "utf8");

  assert.equal(result.totalBytes, expectedTotal);
  assert.equal(Buffer.byteLength(result.tail, "utf8"), STREAM_TAIL_CAP_BYTES);
  assert.ok(result.tail.endsWith(marker));
});

test("outcome metadata in tail of oversized stream is extracted by extractJobOutcomeMetadata", async () => {
  const cap = 1024;
  const noise = "trace-event-payload-".repeat(200); // 4000 bytes
  const tailSummary = "\nOpened PR #412 (headSha: abcdef1234567890abcdef1234567890abcdef12).\n";
  const response = new Response(makeChunkedStream([noise, tailSummary]));

  const { tail, totalBytes } = await readResponseStreamTail(response, cap);
  assert.ok(totalBytes > cap);
  assert.ok(Buffer.byteLength(tail, "utf8") <= cap);

  const metadata = extractJobOutcomeMetadata("", tail);
  assert.equal(metadata.prNumber, 412);
  assert.equal(metadata.headSha, "abcdef1234567890abcdef1234567890abcdef12");
});

test("stream smaller than cap is retained verbatim (byte-identical)", async () => {
  const payload = "hello world\nline 2 with unicode: ✓ 🚀\nend";
  const response = new Response(makeChunkedStream([payload.slice(0, 10), payload.slice(10)]));

  const result = await readResponseStreamTail(response, 1024);
  assert.equal(result.tail, payload);
  assert.equal(result.totalBytes, Buffer.byteLength(payload, "utf8"));
});

test("null stream returns empty tail and zero totalBytes", async () => {
  const result = await readStreamTail(null, 1024);
  assert.deepEqual(result, { tail: "", totalBytes: 0 });
});

test("guard: both dispatch sites route through readResponseStreamTail and never call response.text()", () => {
  const drainSrc = fs.readFileSync(path.join(WEB_UI_ROOT, "lib/board/productionDrain.ts"), "utf8");
  const stageDepsSrc = fs.readFileSync(
    path.join(WEB_UI_ROOT, "lib/board/productionStageDeps.ts"),
    "utf8"
  );

  assert.match(drainSrc, /readResponseStreamTail/);
  assert.match(stageDepsSrc, /readResponseStreamTail/);
  assert.doesNotMatch(drainSrc, /response\.text\s*\(/);
  assert.doesNotMatch(stageDepsSrc, /response\.text\s*\(/);
});

test("production issueAndWait logs item id, stream total bytes, and memory usage on completion", async () => {
  const loggedLines: string[] = [];
  const origInfo = console.info;
  console.info = (...args: unknown[]) => {
    loggedLines.push(args.map(String).join(" "));
  };

  try {
    const issueAndWait = createProductionIssueAndWait({
      hostCheckoutPath: "/tmp/repo",
      executeHostTool: async () => ({ ok: true, exitCode: 0, stdout: "develop\n" }),
      threadStore: {
        createThread: () => ({
          id: "thread-mem-1",
          title: "B-1 Test",
          status: "running",
          model: "test-model",
          reasoningEffort: "medium",
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getThread: async () => ({
          id: "thread-mem-1",
          title: "B-1 Test",
          status: "completed",
          model: "test-model",
          reasoningEffort: "medium",
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: "Done. Opened PR #99.",
              timestamp: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      },
      dispatchChatTurn: async () => ({
        ok: true,
        status: 200,
        rawStream: "tail-bytes",
        streamTotalBytes: 987654,
      }),
    });

    const nowIso = new Date().toISOString();
    const outcome = await issueAndWait({
      item: {
        id: "item-mem-42",
        key: "B-42",
        title: "Memory visibility test",
        brief: "Run job",
        status: "queued",
        dependencies: [],
        author: "Owner",
        source: "manual",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      brief: "Run job",
    });

    assert.equal(outcome.status, "completed");
    const memLog = loggedLines.find((line) => line.includes("item-mem-42"));
    assert.ok(memLog, `Expected memory log line with item id, got: ${JSON.stringify(loggedLines)}`);
    assert.match(memLog, /streamTotalBytes=987654/);
    assert.match(memLog, /rssMB=\d+\.\d+/);
    assert.match(memLog, /heapUsedMB=\d+\.\d+/);
  } finally {
    console.info = origInfo;
  }
});
