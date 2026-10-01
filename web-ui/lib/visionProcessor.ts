/**
 * Vision Processor for Multimodal Diagram Ingestion
 * Uses gemma4:e4b via Ollama vision API to extract system architecture,
 * component boundaries, network protocol endpoints, and database schemas.
 */

export interface DiagramInput {
  name: string;
  base64: string;
  type?: string;
}

export interface ExtractedArchitectureSpec {
  diagramName: string;
  markdownSpec: string;
  extractedAt: string;
  modelUsed: string;
}

const VISION_SYSTEM_PROMPT = `You are a Principal Software Architect and visual reverse-engineering expert.
Analyze the provided system architecture diagram, draw.io schematic, or UI wireframe with extreme technical precision.
Extract and synthesize a standardized, implementation-ready Markdown architecture specification covering:

1. **System Overview & Component Boundaries**:
   - List each discrete service, container, or component identified.
   - Describe each component's responsibility and runtime boundaries.

2. **Network Protocol Endpoints & Communication Topology**:
   - Explicit API protocols (HTTP/REST, gRPC, SSE, WebSockets, Kafka, AMQP).
   - Port allocations, ingress/egress directions, and service mesh connections.

3. **Data Flow & Storage Schemas**:
   - Databases (PostgreSQL, Redis, Vector DB, SQLite), caches, message queues, and persistent volumes.
   - State lifecycles and data persistence boundaries.

4. **Security & Isolation Architecture**:
   - Air-gapped boundaries, zero-trust constraints, unprivileged UID/GIDs, network policies, or credential vaults.

Structure your output cleanly in Markdown with tables, bullet points, and code blocks.`;

export async function extractArchitectureSpec(
  diagram: DiagramInput,
  ollamaBaseUrl: string = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  visionModel: string = "gemma4:e4b"
): Promise<ExtractedArchitectureSpec> {
  const startTime = Date.now();
  console.log(`[VisionProcessor] Ingesting diagram '${diagram.name}' via ${visionModel}...`);

  try {
    const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: visionModel,
        messages: [
          {
            role: "system",
            content: VISION_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: `Analyze this architecture diagram / draw.io export named '${diagram.name}' and generate the standardized Markdown architecture specification.`,
            images: [diagram.base64]
          }
        ],
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: 16384,
          num_predict: 4096
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama vision request failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const markdownSpec = data.message?.content || "[No spec extracted from diagram]";

    console.log(
      `[VisionProcessor] Successfully extracted spec for '${diagram.name}' in ${Date.now() - startTime}ms`
    );

    return {
      diagramName: diagram.name,
      markdownSpec,
      extractedAt: new Date().toISOString(),
      modelUsed: visionModel
    };
  } catch (err: any) {
    console.warn(`[VisionProcessor] Vision extraction error on '${diagram.name}':`, err.message);
    return {
      diagramName: diagram.name,
      markdownSpec: `### Architecture Diagram: ${diagram.name}\n\n*Note: Automated multimodal diagram ingestion encountered an issue (${err.message}). Proceeding with file metadata.*`,
      extractedAt: new Date().toISOString(),
      modelUsed: visionModel
    };
  }
}
