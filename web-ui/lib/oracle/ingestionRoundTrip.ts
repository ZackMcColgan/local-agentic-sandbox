import crypto from "crypto";

export function toQdrantPointId(rawId: string): string {
  const hash = crypto.createHash("sha256").update(rawId).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface StoredPoint {
  id: string;
  content: string;
  vector: number[];
}

export class InMemorySemanticStore {
  private points: StoredPoint[] = [];

  ingest(rawId: string, content: string, vector: number[]): string {
    const id = toQdrantPointId(rawId);
    this.points.push({ id, content, vector });
    return id;
  }

  retrieve(queryVector: number[], topK = 3): Array<StoredPoint & { score: number }> {
    return this.points
      .map((p) => ({ ...p, score: cosineSimilarity(queryVector, p.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
