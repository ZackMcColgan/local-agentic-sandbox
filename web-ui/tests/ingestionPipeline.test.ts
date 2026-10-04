import { test } from 'node:test';
import assert from 'node:assert';
import {
  chunkDocument,
  generateDocumentVectors,
  createQdrantCollectionPayload,
  buildQdrantUpsertPoints,
  DocumentChunk,
  IngestionDocument,
} from '../lib/oracle/ingestion';

test('Phase 2 — Ingestion Pipeline Skeleton Suite', async (t) => {
  await t.test('chunks document deterministically with line ranges and overlap', () => {
    const doc: IngestionDocument = {
      filePath: 'src/utils/math.ts',
      corpus: 'local-repo',
      content: [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function multiply(a: number, b: number): number {',
        '  return a * b;',
        '}',
        '',
        'export function subtract(a: number, b: number): number {',
        '  return a - b;',
        '}',
      ].join('\n'),
    };

    const chunks = chunkDocument(doc, { maxChunkLines: 5, overlapLines: 2 });
    assert(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);

    // Verify first chunk
    assert.strictEqual(chunks[0].filePath, 'src/utils/math.ts');
    assert.strictEqual(chunks[0].startLine, 1);
    assert(chunks[0].endLine <= 5);
    assert(chunks[0].content.includes('export function add'));

    // Verify metadata and citation readiness
    for (const chunk of chunks) {
      assert(chunk.citation.startsWith('src/utils/math.ts:'));
      assert(typeof chunk.checksum === 'string');
      assert.strictEqual(chunk.corpus, 'local-repo');
    }
  });

  await t.test('creates Qdrant collection payload with cosine distance and correct vector size', () => {
    const payload = createQdrantCollectionPayload('codebase-index', 768);
    assert.strictEqual(payload.name, 'codebase-index');
    assert.strictEqual(payload.vectors.size, 768);
    assert.strictEqual(payload.vectors.distance, 'Cosine');
  });

  await t.test('builds Qdrant points payload for upsert with file:line citation metadata', async () => {
    const chunks: DocumentChunk[] = [
      {
        id: 'chunk-1',
        filePath: 'docs/ADR-001.md',
        startLine: 1,
        endLine: 10,
        content: '# ADR 001: Sandboxed MCP Architecture',
        citation: 'docs/ADR-001.md:1-10',
        checksum: 'abc123hash',
        corpus: 'docs',
      },
      {
        id: 'chunk-2',
        filePath: 'docs/ADR-001.md',
        startLine: 9,
        endLine: 20,
        content: 'Decision: Enforce network-isolated MCP runner container.',
        citation: 'docs/ADR-001.md:9-20',
        checksum: 'def456hash',
        corpus: 'docs',
      },
    ];

    // Mock embedding generator function
    const mockEmbedder = async (texts: string[]) => {
      return texts.map(() => new Array(768).fill(0.05));
    };

    const points = await buildQdrantUpsertPoints(chunks, mockEmbedder);
    assert.strictEqual(points.length, 2);
    assert.strictEqual(points[0].id, 'chunk-1');
    assert.strictEqual(points[0].vector.length, 768);
    assert.strictEqual(points[0].payload.citation, 'docs/ADR-001.md:1-10');
    assert.strictEqual(points[0].payload.filePath, 'docs/ADR-001.md');
    assert.strictEqual(points[0].payload.corpus, 'docs');
    assert.strictEqual(points[0].payload.startLine, 1);
  });

  await t.test('Oracle grounding: retrieves supervisor file:line citations for worker crash query', async () => {
    const { searchOracleCodebase } = await import('../lib/oracle/ingestion');
    const result = await searchOracleCodebase('how does the supervisor handle a crashed worker?');

    assert.ok(result.citations.length > 0, 'Must return at least one citation');
    const supervisorCitation = result.citations.find((c) => c.includes('supervisor.ts'));
    assert.ok(supervisorCitation, `Must cite supervisor.ts, got: ${result.citations.join(', ')}`);
    assert.ok(result.contextSnippet.includes('supervisor.ts'), 'Context snippet must include supervisor source');
  });

  await t.test('Oracle grounding: does not fabricate citations for general ungrounded questions', async () => {
    const { searchOracleCodebase } = await import('../lib/oracle/ingestion');
    const result = await searchOracleCodebase('write a haiku about rain');

    assert.strictEqual(result.citations.length, 0, 'Must not return citations for general questions');
    assert.strictEqual(result.contextSnippet, '', 'Context snippet must be empty for general questions');
  });
});
