import crypto from 'node:crypto';

export interface IngestionDocument {
  filePath: string;
  corpus: string;
  content: string;
}

export interface ChunkOptions {
  maxChunkLines?: number;
  overlapLines?: number;
}

export interface DocumentChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  citation: string;
  checksum: string;
  corpus: string;
}

export interface QdrantCollectionConfig {
  name: string;
  vectors: {
    size: number;
    distance: 'Cosine' | 'Euclid' | 'Dot';
  };
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: {
    citation: string;
    filePath: string;
    startLine: number;
    endLine: number;
    corpus: string;
    content: string;
    checksum: string;
  };
}

/**
 * Deterministically chunks a document with line range awareness and citation anchors
 */
export function chunkDocument(
  doc: IngestionDocument,
  options: ChunkOptions = {}
): DocumentChunk[] {
  const maxChunkLines = options.maxChunkLines ?? 50;
  const overlapLines = options.overlapLines ?? 10;
  const lines = doc.content.split('\n');
  const chunks: DocumentChunk[] = [];

  let currentLine = 0;
  let chunkIdx = 0;

  while (currentLine < lines.length) {
    const startLine = currentLine + 1; // 1-indexed
    const chunkEnd = Math.min(currentLine + maxChunkLines, lines.length);
    const chunkSlice = lines.slice(currentLine, chunkEnd);
    const endLine = chunkEnd;

    const content = chunkSlice.join('\n');
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    const id = `${doc.filePath.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${chunkIdx}`;
    const citation = `${doc.filePath}:${startLine}-${endLine}`;

    chunks.push({
      id,
      filePath: doc.filePath,
      startLine,
      endLine,
      content,
      citation,
      checksum,
      corpus: doc.corpus,
    });

    chunkIdx++;
    if (chunkEnd >= lines.length) {
      break;
    }
    currentLine += maxChunkLines - overlapLines;
  }

  return chunks;
}

/**
 * Creates Qdrant collection specification payload
 */
export function createQdrantCollectionPayload(
  collectionName: string,
  vectorSize = 768
): QdrantCollectionConfig {
  return {
    name: collectionName,
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
    },
  };
}

/**
 * Builds vector points ready for upsert into Qdrant vector database
 */
export async function buildQdrantUpsertPoints(
  chunks: DocumentChunk[],
  embedder: (texts: string[]) => Promise<number[][]>
): Promise<QdrantPoint[]> {
  const texts = chunks.map((c) => c.content);
  const vectors = await embedder(texts);

  return chunks.map((chunk, index) => ({
    id: chunk.id,
    vector: vectors[index] || [],
    payload: {
      citation: chunk.citation,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      corpus: chunk.corpus,
      content: chunk.content,
      checksum: chunk.checksum,
    },
  }));
}

/**
 * End-to-end helper to process and vectorize a batch of documents
 */
export async function generateDocumentVectors(
  docs: IngestionDocument[],
  embedder: (texts: string[]) => Promise<number[][]>,
  options?: ChunkOptions
): Promise<QdrantPoint[]> {
  const allChunks: DocumentChunk[] = [];
  for (const doc of docs) {
    const chunks = chunkDocument(doc, options);
    allChunks.push(...chunks);
  }
  return buildQdrantUpsertPoints(allChunks, embedder);
}
