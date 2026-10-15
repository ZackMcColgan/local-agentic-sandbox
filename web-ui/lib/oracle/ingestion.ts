import crypto from 'node:crypto';

export interface IngestionDocument {
  filePath: string;
  corpus: string;
  content: string;
}

export interface ChunkOptions {
  maxChunkLines?: number;
  overlapLines?: number;
  strategy?: "line" | "ast" | "syntax";
}

export interface SyntaxBoundary {
  lineIndex: number; // 0-indexed
  type: "function" | "class" | "interface" | "type" | "heading" | "block";
  name?: string;
}

/**
 * Detects syntax boundaries (functions, classes, interfaces, markdown headings)
 * to align chunks with natural code/doc structural boundaries.
 */
export function detectSyntaxBoundaries(lines: string[], filePath: string): SyntaxBoundary[] {
  const boundaries: SyntaxBoundary[] = [];
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const isMd = ext === 'md' || ext === 'markdown';
  const isCode = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (isMd) {
      if (/^#{1,6}\s+/.test(trimmed)) {
        boundaries.push({ lineIndex: i, type: "heading", name: trimmed });
      } else if (/^---$/.test(trimmed)) {
        boundaries.push({ lineIndex: i, type: "block", name: "separator" });
      }
    } else if (isCode) {
      // Top-level or exported functions
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/);
      if (fnMatch) {
        boundaries.push({ lineIndex: i, type: "function", name: fnMatch[1] });
        continue;
      }
      // Top-level classes
      const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/);
      if (classMatch) {
        boundaries.push({ lineIndex: i, type: "class", name: classMatch[1] });
        continue;
      }
      // Interfaces, types, enums
      const ifaceMatch = trimmed.match(/^(?:export\s+)?(?:interface|type|enum)\s+([a-zA-Z0-9_$]+)/);
      if (ifaceMatch) {
        boundaries.push({ lineIndex: i, type: "interface", name: ifaceMatch[1] });
        continue;
      }
      // Const arrow functions
      const constFnMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/);
      if (constFnMatch) {
        boundaries.push({ lineIndex: i, type: "function", name: constFnMatch[1] });
        continue;
      }
      // Test definitions
      const testMatch = trimmed.match(/^(?:test|describe|it)\s*\(\s*["'`]([^"'`]+)/);
      if (testMatch) {
        boundaries.push({ lineIndex: i, type: "block", name: testMatch[1] });
        continue;
      }
    }
  }
  return boundaries;
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
 * Deterministically chunks a document with line range awareness, citation anchors,
 * and syntax boundary / AST awareness (functions, classes, interfaces, markdown headings).
 */
export function chunkDocument(
  doc: IngestionDocument,
  options: ChunkOptions = {}
): DocumentChunk[] {
  const maxChunkLines = options.maxChunkLines ?? 50;
  const overlapLines = options.overlapLines ?? 10;
  const strategy = options.strategy ?? "ast";
  const lines = doc.content.split('\n');
  const chunks: DocumentChunk[] = [];

  if (lines.length === 0) return chunks;

  // Detect syntax boundaries for ast/syntax strategy
  const boundaries = strategy === "line" ? [] : detectSyntaxBoundaries(lines, doc.filePath);

  let currentLine = 0;
  let chunkIdx = 0;

  while (currentLine < lines.length) {
    const startLine = currentLine + 1; // 1-indexed
    let chunkEnd = Math.min(currentLine + maxChunkLines, lines.length);

    if (boundaries.length > 0 && chunkEnd < lines.length) {
      // Look for the best syntax boundary in [currentLine + 1, chunkEnd]
      const candidateBoundaries = boundaries.filter(
        (b) => b.lineIndex > currentLine && b.lineIndex <= chunkEnd
      );

      if (candidateBoundaries.length > 0) {
        const minLines = Math.max(3, Math.floor(maxChunkLines * 0.3));
        const eligible = candidateBoundaries.filter((b) => b.lineIndex - currentLine >= minLines);
        if (eligible.length > 0) {
          const chosen = eligible[eligible.length - 1];
          chunkEnd = chosen.lineIndex;
        }
      }
    }

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

    if (boundaries.length > 0 && chunkEnd < lines.length) {
      currentLine = chunkEnd;
    } else {
      currentLine += Math.max(1, maxChunkLines - overlapLines);
    }
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

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "did", "do", "does",
  "doing", "down", "during", "each", "few", "for", "from", "further", "had",
  "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "just", "me", "more", "most",
  "my", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other",
  "our", "out", "over", "own", "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "you", "your"
]);

/**
 * Deterministic hash-based dense embedding generator (768 dimensions).
 * Produces unit L2-normalized vector based on word and char 3-gram frequencies.
 * High cosine similarity for semantically overlapping text.
 */
export function deterministicEmbedding(text: string, dim = 768): number[] {
  const vec = new Float64Array(dim);
  if (!text || typeof text !== "string") return Array.from(vec);

  const clean = text.toLowerCase();
  const rawWords = clean.match(/[a-z0-9_]{2,}/g) || [];
  const words = rawWords.filter((w) => !STOPWORDS.has(w));

  for (const word of words) {
    // Word hashing
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
      h ^= word.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const idx = Math.abs(h) % dim;
    vec[idx] += 3.0;

    // Subword n-grams for typo and inflection tolerance (min length 4)
    if (word.length >= 4) {
      for (let i = 0; i <= word.length - 3; i++) {
        const sub = word.slice(i, i + 3);
        let sh = 0x811c9dc5;
        for (let j = 0; j < sub.length; j++) {
          sh ^= sub.charCodeAt(j);
          sh = Math.imul(sh, 0x01000193);
        }
        const sidx = Math.abs(sh) % dim;
        vec[sidx] += 0.4;
      }
    }
  }

  // L2 normalization
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm;
    }
  }

  return Array.from(vec);
}

/**
 * Computes cosine similarity between two unit vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return Math.max(0, Math.min(1, dot));
}

// In-memory cache of indexed codebase chunks
let inMemoryChunkIndex: DocumentChunk[] = [];
let inMemoryVectors: number[][] = [];
let lastIndexedTime = 0;

/**
 * Crawls and indexes workspace files.
 */
export async function indexWorkspaceCodebase(
  workspaceRoot?: string,
  qdrantUrl?: string
): Promise<{ indexedFiles: number; totalChunks: number }> {
  const fs = await import("fs");
  const path = await import("path");

  const root =
    workspaceRoot ||
    (fs.existsSync(path.join(process.cwd(), "web-ui"))
      ? process.cwd()
      : path.resolve(process.cwd(), ".."));

  const targetDirs = [
    path.join(root, "web-ui", "lib"),
    path.join(root, "web-ui", "components"),
    path.join(root, "mcp-server"),
    path.join(root, "docs")
  ];

  const allowedExtensions = [".ts", ".tsx", ".js", ".json", ".md", ".drawio"];
  const docs: IngestionDocument[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".next" ||
          entry.name === "build" ||
          entry.name === "dist" ||
          entry.name.includes("package-lock") ||
          entry.name.includes(".test.") ||
          entry.name.includes(".spec.")
        ) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (allowedExtensions.includes(ext) && !entry.name.endsWith(".lock")) {
            try {
              const content = fs.readFileSync(fullPath, "utf8");
              const relPath = path.relative(root, fullPath).replace(/\\/g, "/");
              docs.push({
                filePath: relPath,
                corpus: "local-repo",
                content
              });
            } catch {}
          }
        }
      }
    } catch {}
  }

  for (const dir of targetDirs) {
    walk(dir);
  }

  const allChunks: DocumentChunk[] = [];
  for (const doc of docs) {
    const chunks = chunkDocument(doc, { maxChunkLines: 40, overlapLines: 8 });
    allChunks.push(...chunks);
  }

  inMemoryChunkIndex = allChunks;
  inMemoryVectors = allChunks.map((c) => deterministicEmbedding(`${c.filePath} ${c.filePath} ${c.content}`));
  lastIndexedTime = Date.now();

  // If Qdrant is configured/available, sync collection & points
  const qUrl =
    qdrantUrl ||
    process.env.QDRANT_URL ||
    (process.env.NODE_ENV === "production" ? "http://qdrant-service:6333" : "http://127.0.0.1:6333");

  try {
    const collectionName = "codebase-index";
    // Check collection exists
    const checkRes = await fetch(`${qUrl}/collections/${collectionName}`);
    if (!checkRes.ok) {
      await fetch(`${qUrl}/collections/${collectionName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createQdrantCollectionPayload(collectionName, 768))
      });
    }

    // Upsert batch in chunks of 100
    const points: QdrantPoint[] = allChunks.map((chunk, idx) => ({
      id: `${chunk.id}_${idx}`.slice(0, 64),
      vector: inMemoryVectors[idx],
      payload: {
        citation: chunk.citation,
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        corpus: chunk.corpus,
        content: chunk.content,
        checksum: chunk.checksum
      }
    }));

    for (let i = 0; i < points.length; i += 100) {
      const slice = points.slice(i, i + 100);
      await fetch(`${qUrl}/collections/${collectionName}/points`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: slice })
      });
    }
  } catch (err: any) {
    // Qdrant sync notice: fallback to inMemoryChunkIndex
  }

  return {
    indexedFiles: docs.length,
    totalChunks: allChunks.length
  };
}

export interface RetrievalResult {
  contextSnippet: string;
  citations: string[];
  hits: Array<{
    citation: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    score: number;
  }>;
}

/**
 * Searches the Oracle codebase index using Qdrant (with in-memory fallback).
 * Only returns results if relevance score meets minScore threshold and shares meaningful query keywords.
 */
export async function searchOracleCodebase(
  query: string,
  options: {
    workspaceRoot?: string;
    qdrantUrl?: string;
    limit?: number;
    minScore?: number;
  } = {}
): Promise<RetrievalResult> {
  const limit = options.limit ?? 3;
  const minScore = options.minScore ?? 0.28;

  // Extract non-stopword query keywords
  const cleanQuery = query.toLowerCase();
  const queryTerms = (cleanQuery.match(/[a-z0-9_]{3,}/g) || []).filter(
    (t) => !STOPWORDS.has(t) && t !== "write" && t !== "explain" && t !== "tell" && t !== "give"
  );

  // If query has no domain terms, it is a generic knowledge or conversational prompt
  if (queryTerms.length === 0) {
    return { contextSnippet: "", citations: [], hits: [] };
  }

  // Lazily index if not yet indexed or older than 5 minutes
  if (inMemoryChunkIndex.length === 0 || Date.now() - lastIndexedTime > 300000) {
    await indexWorkspaceCodebase(options.workspaceRoot, options.qdrantUrl);
  }

  const queryVec = deterministicEmbedding(query);
  const qUrl =
    options.qdrantUrl ||
    process.env.QDRANT_URL ||
    (process.env.NODE_ENV === "production" ? "http://qdrant-service:6333" : "http://127.0.0.1:6333");

  let hits: Array<{
    citation: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    score: number;
  }> = [];

  // Try Qdrant REST search first
  try {
    const res = await fetch(`${qUrl}/collections/codebase-index/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: queryVec,
        limit: limit * 3,
        with_payload: true
      })
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.result)) {
        for (const item of data.result) {
          const content = item.payload?.content || "";
          const filePath = item.payload?.filePath || "";
          const matchCount = queryTerms.filter((t) => {
            const re = new RegExp(`\\b${t}\\b`, "i");
            return re.test(content) || re.test(filePath);
          }).length;

          if (matchCount > 0 && item.score >= minScore) {
            const combinedScore = item.score * 0.6 + (matchCount / queryTerms.length) * 0.4;
            hits.push({
              citation: item.payload?.citation || "",
              filePath: item.payload?.filePath || "",
              startLine: item.payload?.startLine || 1,
              endLine: item.payload?.endLine || 1,
              content: item.payload?.content || "",
              score: combinedScore
            });
          }
        }
      }
    }
  } catch {}

  // Fallback / complement with in-memory search
  if (hits.length === 0 && inMemoryChunkIndex.length > 0) {
    const scored: Array<{ chunk: DocumentChunk; score: number }> = [];

    for (let idx = 0; idx < inMemoryChunkIndex.length; idx++) {
      const chunk = inMemoryChunkIndex[idx];
      const content = chunk.content;
      const filePath = chunk.filePath;

      const matchedTerms = queryTerms.filter((t) => {
        const re = new RegExp(`\\b${t}\\b`, "i");
        return re.test(content) || re.test(filePath);
      });
      if (matchedTerms.length === 0) continue;

      const cos = cosineSimilarity(queryVec, inMemoryVectors[idx]);
      const keywordRatio = matchedTerms.length / queryTerms.length;
      const combinedScore = cos * 0.5 + keywordRatio * 0.5;

      if (combinedScore >= minScore) {
        scored.push({ chunk, score: combinedScore });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    hits = scored.slice(0, limit).map((s) => ({
      citation: s.chunk.citation,
      filePath: s.chunk.filePath,
      startLine: s.chunk.startLine,
      endLine: s.chunk.endLine,
      content: s.chunk.content,
      score: s.score
    }));
  }

  hits.sort((a, b) => b.score - a.score);
  hits = hits.slice(0, limit);

  if (hits.length === 0) {
    return { contextSnippet: "", citations: [], hits: [] };
  }

  const citations = Array.from(new Set(hits.map((h) => h.citation)));
  const snippetParts = hits.map(
    (h) => `[Source: ${h.citation}]\n${h.content.slice(0, 1500)}`
  );

  const contextSnippet = `\n\n--- LOCAL REPOSITORY GROUNDING CONTEXT (ORACLE RETRIEVAL) ---\n${snippetParts.join("\n\n")}\n--- END LOCAL CONTEXT ---`;

  return {
    contextSnippet,
    citations,
    hits
  };
}
