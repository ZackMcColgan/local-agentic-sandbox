import fs from "fs";
import path from "path";
import { ingestDocsToQdrant } from "../web-ui/lib/memory/semanticMemory.ts";

async function main() {
  const docsDir = path.resolve("docs");
  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
  const docs = [];

  for (const f of files) {
    const fullPath = path.join(docsDir, f);
    const content = fs.readFileSync(fullPath, "utf8");
    docs.push({
      filePath: `docs/${f}`,
      corpus: "docs",
      content
    });
  }

  console.log(`[Ingest] Found ${docs.length} documentation files in docs/`);
  const result = await ingestDocsToQdrant(docs);
  console.log(`[Ingest] Successfully ingested into collection: '${result.collection}'`);
  console.log(`[Ingest] Indexed Files: ${result.indexedFiles}`);
  console.log(`[Ingest] Total Vectors in Qdrant: ${result.pointsCount}`);
}

main().catch((err) => {
  console.error("[Ingest Error]:", err.message);
  process.exit(1);
});
