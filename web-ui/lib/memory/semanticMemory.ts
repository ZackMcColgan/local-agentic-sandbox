import path from "path";
import fs from "fs";
import { chunkDocument, IngestionDocument } from "../oracle/ingestion";

export const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "all-minilm";
export const DEFAULT_QDRANT_COLLECTION = "agentic-semantic-memory";

export interface SemanticHit {
  id: string;
  score: number;
  citation: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface SemanticQueryResult {
  hits: SemanticHit[];
  citations: string[];
  contextSnippet: string;
  degraded: boolean;
  degradationReason?: string;
}

export function getOllamaBaseUrl(custom?: string): string {
  return custom || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
}

export function getQdrantUrl(custom?: string): string {
  return (
    custom ||
    process.env.QDRANT_URL ||
    (process.env.NODE_ENV === "production" ? "http://qdrant-service:6333" : "http://127.0.0.1:6333")
  );
}

/**
 * Generates dense vector embeddings using Ollama.
 * FAILS LOUDLY: Throws if Ollama is unreachable. Never silently succeeds.
 */
export async function generateOllamaEmbedding(
  text: string,
  options: { model?: string; baseUrl?: string } = {}
): Promise<number[]> {
  const baseUrl = getOllamaBaseUrl(options.baseUrl);
  const model = options.model || DEFAULT_EMBEDDING_MODEL;

  try {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: text.slice(0, 500)
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Ollama embedding error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error(`Ollama returned invalid embedding structure: ${JSON.stringify(data)}`);
    }

    return data.embedding;
  } catch (err: any) {
    throw new Error(`Ollama embedding service unreachable at ${baseUrl}: ${err.message}`);
  }
}

/**
 * Checks if a Qdrant collection exists and returns its point count.
 */
export async function getQdrantCollectionInfo(
  collectionName: string = DEFAULT_QDRANT_COLLECTION,
  qdrantUrl?: string
): Promise<{ exists: boolean; pointsCount: number; vectorSize?: number }> {
  const url = getQdrantUrl(qdrantUrl);
  try {
    const res = await fetch(`${url}/collections/${collectionName}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      return { exists: false, pointsCount: 0 };
    }
    const data = await res.json();
    const count = data.result?.points_count ?? 0;
    const size = data.result?.config?.params?.vectors?.size;
    return { exists: true, pointsCount: count, vectorSize: size };
  } catch (err: any) {
    throw new Error(`Qdrant service unreachable at ${url}: ${err.message}`);
  }
}

/**
 * Empties a Qdrant collection by recreating it.
 */
export async function emptyQdrantCollection(
  collectionName: string = DEFAULT_QDRANT_COLLECTION,
  vectorSize = 384,
  qdrantUrl?: string
): Promise<void> {
  const url = getQdrantUrl(qdrantUrl);
  // Delete collection if it exists
  await fetch(`${url}/collections/${collectionName}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});

  // Re-create collection
  const createRes = await fetch(`${url}/collections/${collectionName}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: collectionName,
      vectors: {
        size: vectorSize,
        distance: "Cosine"
      }
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!createRes.ok) {
    throw new Error(`Failed to initialize Qdrant collection ${collectionName}`);
  }
}

/**
 * Ingests repository documentation files into Qdrant using Ollama embeddings.
 * FAILS LOUDLY if Ollama is unreachable.
 */
export async function ingestDocsToQdrant(
  docs: IngestionDocument[],
  options: {
    qdrantUrl?: string;
    collectionName?: string;
    embeddingModel?: string;
    ollamaUrl?: string;
  } = {}
): Promise<{ collection: string; pointsCount: number; indexedFiles: number }> {
  const collectionName = options.collectionName || DEFAULT_QDRANT_COLLECTION;
  const qUrl = getQdrantUrl(options.qdrantUrl);
  const model = options.embeddingModel || DEFAULT_EMBEDDING_MODEL;
  const oUrl = getOllamaBaseUrl(options.ollamaUrl);

  if (docs.length === 0) {
    return { collection: collectionName, pointsCount: 0, indexedFiles: 0 };
  }

  // 1. Chunk documents
  const allChunks: Array<{
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    citation: string;
  }> = [];

  for (const doc of docs) {
    const chunks = chunkDocument(doc, { maxChunkLines: 15, overlapLines: 3 });
    allChunks.push(...chunks);
  }

  if (allChunks.length === 0) {
    return { collection: collectionName, pointsCount: 0, indexedFiles: docs.length };
  }

  // 2. Generate embeddings via Ollama (throws loudly on failure)
  const sampleVector = await generateOllamaEmbedding(allChunks[0].content, {
    model,
    baseUrl: oUrl
  });
  const vectorDim = sampleVector.length;

  // 3. Ensure Qdrant collection exists with proper dimensions
  const colInfo = await getQdrantCollectionInfo(collectionName, qUrl).catch(() => ({ exists: false, pointsCount: 0, vectorSize: undefined }));
  if (!colInfo.exists || colInfo.vectorSize !== vectorDim) {
    await emptyQdrantCollection(collectionName, vectorDim, qUrl);
  }

  // 4. Compute all embeddings and upsert points in batches
  const points: any[] = [];
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const vec = i === 0 ? sampleVector : await generateOllamaEmbedding(chunk.content, { model, baseUrl: oUrl });
    points.push({
      id: i + 1,
      vector: vec,
      payload: {
        citation: chunk.citation,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content
      }
    });
  }

  // Batch upsert to Qdrant with synchronous flush wait
  const upsertRes = await fetch(`${qUrl}/collections/${collectionName}/points?wait=true`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
    signal: AbortSignal.timeout(10000)
  });

  if (!upsertRes.ok) {
    const errText = await upsertRes.text().catch(() => upsertRes.statusText);
    throw new Error(`Qdrant upsert failed (${upsertRes.status}): ${errText}`);
  }

  const updatedInfo = await getQdrantCollectionInfo(collectionName, qUrl);
  return {
    collection: collectionName,
    pointsCount: updatedInfo.pointsCount,
    indexedFiles: docs.length
  };
}

/**
 * Searches semantic memory in Qdrant.
 * Flags degradation explicitly if Ollama or Qdrant is unreachable.
 * Answers with citations when relevant docs exist, empty citations otherwise.
 */
export async function searchSemanticMemory(
  query: string,
  options: {
    qdrantUrl?: string;
    collectionName?: string;
    embeddingModel?: string;
    ollamaUrl?: string;
    limit?: number;
    minScore?: number;
  } = {}
): Promise<SemanticQueryResult> {
  const collectionName = options.collectionName || DEFAULT_QDRANT_COLLECTION;
  const qUrl = getQdrantUrl(options.qdrantUrl);
  const oUrl = getOllamaBaseUrl(options.ollamaUrl);
  const model = options.embeddingModel || DEFAULT_EMBEDDING_MODEL;
  const limit = options.limit ?? 3;
  const minScore = options.minScore ?? 0.35;

  if (!query || !query.trim()) {
    return { hits: [], citations: [], contextSnippet: "", degraded: false };
  }

  // Step 1: Embed query via Ollama
  let queryVector: number[];
  try {
    queryVector = await generateOllamaEmbedding(query, { model, baseUrl: oUrl });
  } catch (err: any) {
    console.warn("[SemanticMemory] Degraded recall: Ollama embedding unreachable:", err.message);
    return {
      hits: [],
      citations: [],
      contextSnippet: "",
      degraded: true,
      degradationReason: `Ollama embedding service unreachable: ${err.message}`
    };
  }

  // Step 2: Search Qdrant vector database
  try {
    const searchRes = await fetch(`${qUrl}/collections/${collectionName}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: queryVector,
        limit,
        with_payload: true
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!searchRes.ok) {
      return { hits: [], citations: [], contextSnippet: "", degraded: false };
    }

    const data = await searchRes.json();
    const rawHits = data.result || [];

    const hits: SemanticHit[] = [];
    const citations: string[] = [];

    for (const h of rawHits) {
      if (h.score >= minScore && h.payload) {
        const hit: SemanticHit = {
          id: String(h.id),
          score: h.score,
          citation: h.payload.citation || `${h.payload.filePath}:${h.payload.startLine}-${h.payload.endLine}`,
          filePath: h.payload.filePath,
          startLine: h.payload.startLine,
          endLine: h.payload.endLine,
          content: h.payload.content
        };
        hits.push(hit);
        citations.push(hit.citation);
      }
    }

    if (hits.length === 0) {
      return { hits: [], citations: [], contextSnippet: "", degraded: false };
    }

    const snippetLines = [
      "\n--- GROUNDED KNOWLEDGE & VERIFIED CITATIONS ---",
      "The following relevant source excerpts were retrieved from local project documentation:"
    ];

    for (const h of hits) {
      snippetLines.push(`\n[Source: ${h.citation}]\n${h.content}\n[End Source: ${h.citation}]`);
    }

    snippetLines.push("--- END GROUNDED KNOWLEDGE ---\n");

    return {
      hits,
      citations,
      contextSnippet: snippetLines.join("\n"),
      degraded: false
    };
  } catch (err: any) {
    console.warn("[SemanticMemory] Degraded recall: Qdrant unreachable:", err.message);
    return {
      hits: [],
      citations: [],
      contextSnippet: "",
      degraded: true,
      degradationReason: `Qdrant vector database unreachable: ${err.message}`
    };
  }
}
