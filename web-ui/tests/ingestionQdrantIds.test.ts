import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildQdrantUpsertPoints, type DocumentChunk } from "../lib/oracle/ingestion";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("B-14: Qdrant point IDs in real ingestion path", () => {
  it("buildQdrantUpsertPoints emits deterministic UUID v4 point IDs", async () => {
    const chunks: DocumentChunk[] = [
      {
        id: "doc-alpha_chunk_0",
        citation: "alpha.md:1-10",
        filePath: "alpha.md",
        startLine: 1,
        endLine: 10,
        corpus: "test",
        content: "hello world",
        checksum: "abc123",
      },
      {
        id: "doc-alpha_chunk_1",
        citation: "alpha.md:11-20",
        filePath: "alpha.md",
        startLine: 11,
        endLine: 20,
        corpus: "test",
        content: "second chunk",
        checksum: "def456",
      },
    ];
    const embedder = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

    const points1 = await buildQdrantUpsertPoints(chunks, embedder);
    const points2 = await buildQdrantUpsertPoints(chunks, embedder);

    assert.strictEqual(points1.length, 2);
    for (const pt of points1) {
      assert.match(pt.id, UUID_V4_RE, `Expected UUID v4 point id, got: ${pt.id}`);
    }
    assert.notStrictEqual(points1[0].id, points1[1].id);
    assert.strictEqual(points1[0].id, points2[0].id, "Point IDs must be deterministic");
    assert.strictEqual(points1[1].id, points2[1].id, "Point IDs must be deterministic");
  });
});
