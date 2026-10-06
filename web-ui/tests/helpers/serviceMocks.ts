import { execSync } from "child_process";

export type ServiceName = "ollama" | "qdrant" | "drawio";

let ollamaAvailable: boolean | null = null;
let qdrantAvailable: boolean | null = null;
let drawioAvailable: boolean | null = null;

export async function checkOllama(baseUrl = "http://127.0.0.1:11434"): Promise<boolean> {
  if (process.env.FORCE_MOCK === "1") return false;
  if (ollamaAvailable !== null) return ollamaAvailable;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(600)
    });
    ollamaAvailable = res.ok;
  } catch {
    ollamaAvailable = false;
  }
  if (!ollamaAvailable && process.env.FORCE_REAL === "1") {
    throw new Error(`FORCE_REAL=1 but Ollama service is unreachable at ${baseUrl}`);
  }
  return ollamaAvailable;
}

export async function checkQdrant(url = "http://127.0.0.1:6333"): Promise<boolean> {
  if (process.env.FORCE_MOCK === "1") return false;
  if (qdrantAvailable !== null) return qdrantAvailable;
  try {
    const res = await fetch(`${url}/collections`, {
      signal: AbortSignal.timeout(600)
    });
    qdrantAvailable = res.ok;
  } catch {
    qdrantAvailable = false;
  }
  if (!qdrantAvailable && process.env.FORCE_REAL === "1") {
    throw new Error(`FORCE_REAL=1 but Qdrant service is unreachable at ${url}`);
  }
  return qdrantAvailable;
}

export function checkDrawio(): boolean {
  if (process.env.FORCE_MOCK === "1") return false;
  if (drawioAvailable !== null) return drawioAvailable;
  try {
    execSync("which drawio || which draw.io", { stdio: "ignore" });
    drawioAvailable = true;
  } catch {
    drawioAvailable = false;
  }
  if (!drawioAvailable && process.env.FORCE_REAL === "1") {
    throw new Error("FORCE_REAL=1 but draw.io CLI binary is not installed");
  }
  return drawioAvailable;
}

export function logServiceMode(service: ServiceName, isReal: boolean): void {
  console.log(isReal ? `[real:${service}]` : `[mock:${service}]`);
}

let originalFetch: typeof globalThis.fetch | null = null;
let ollamaMockActive = false;
let qdrantMockActive = false;

export function enableOllamaMock(): void {
  ollamaMockActive = true;
  installFetchInterceptor();
}

export function disableOllamaMock(): void {
  ollamaMockActive = false;
  maybeRestoreFetch();
}

export function enableQdrantMock(): void {
  qdrantMockActive = true;
  installFetchInterceptor();
}

export function disableQdrantMock(): void {
  qdrantMockActive = false;
  maybeRestoreFetch();
}

function installFetchInterceptor() {
  if (!originalFetch) {
    originalFetch = globalThis.fetch;
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Preserving degradation tests: do NOT intercept intentional failure endpoints (e.g. port 9999 or 54321)
    if (url.includes(":9999") || url.includes(":54321")) {
      return originalFetch!(input, init);
    }

    // 1. Ollama Mock
    if (ollamaMockActive && (url.includes(":11434") || url.includes("ollama"))) {
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "swift-27b-mtp", modified_at: new Date().toISOString() },
              { name: "all-minilm", modified_at: new Date().toISOString() }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/api/embeddings") || url.includes("/api/embed")) {
        // Return dense 384-dimensional vector of real numbers
        const embedding = new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.5);
        return new Response(
          JSON.stringify({ embedding }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/api/generate")) {
        const bodyStr = typeof init?.body === "string" ? init.body : "";
        let body: any = {};
        try {
          body = JSON.parse(bodyStr);
        } catch {}

        const prompt: string = body.prompt || "";
        const model: string = body.model || "swift-27b-mtp";

        // Check if prompt is a critic evaluation
        if (prompt.includes("critic") || prompt.includes("Adversarial code review") || prompt.includes("Critically inspect the diff")) {
          const hasFlaw =
            prompt.includes("// FORCED_FLAW") ||
            (prompt.includes("egress-mesh") && prompt.includes("network = ai-mesh")) ||
            (prompt.includes("PORT = 3000") && prompt.includes("+ export const PORT = 3000"));

          if (hasFlaw) {
            return new Response(
              JSON.stringify({
                model,
                response: JSON.stringify({
                  approved: false,
                  feedback: ["Discrepancy detected: criterion requirements violated by diff content."],
                  analysis: "Diff fails acceptance criteria."
                }),
                done: true,
                load_duration: 1000,
                total_duration: 50000
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          return new Response(
            JSON.stringify({
              model,
              response: JSON.stringify({
                approved: true,
                feedback: [],
                analysis: "All acceptance criteria verified."
              }),
              done: true,
              load_duration: 1000,
              total_duration: 50000
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // If prompt is planner
        if (prompt.includes("planner") || prompt.includes("Decompose the following goal into 3 to 5 verifiable")) {
          return new Response(
            JSON.stringify({
              model,
              response: JSON.stringify({
                goal: "Build autonomous architecture diagram",
                milestones: [
                  {
                    id: "M1",
                    title: "Topology Discovery",
                    description: "Catalog services and networks",
                    acceptanceCriteria: [{ id: "AC1", assertion: "5 services cataloged" }]
                  },
                  {
                    id: "M2",
                    title: "Draw.io Generation",
                    description: "Produce diagram with white background",
                    acceptanceCriteria: [{ id: "AC2", assertion: "Valid draw.io XML produced" }]
                  },
                  {
                    id: "M3",
                    title: "Verification",
                    description: "Verify diagram against specification",
                    acceptanceCriteria: [{ id: "AC3", assertion: "Vector diagram verified" }]
                  }
                ]
              }),
              done: true,
              load_duration: 1000,
              total_duration: 50000
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            model,
            response: "Mocked model output",
            done: true,
            load_duration: 1000,
            total_duration: 50000
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 2. Qdrant Mock
    if (qdrantMockActive && (url.includes(":6333") || url.includes("qdrant"))) {
      if (url.includes("/collections")) {
        if (init?.method === "DELETE") {
          return new Response(JSON.stringify({ result: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (init?.method === "PUT" && !url.includes("/points")) {
          return new Response(JSON.stringify({ result: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (url.includes("/points?wait=true") || (init?.method === "PUT" && url.includes("/points"))) {
          return new Response(
            JSON.stringify({ result: { operation_id: 1, status: "completed" } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.includes("/points/search")) {
          if (url.includes("test-empty")) {
            return new Response(
              JSON.stringify({ result: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          return new Response(
            JSON.stringify({
              result: [
                {
                  id: 1,
                  score: 0.94,
                  payload: {
                    citation: "docs/ADR-002-langgraph-supervisor-checkpoints.md:45",
                    filePath: "docs/ADR-002-langgraph-supervisor-checkpoints.md",
                    startLine: 45,
                    endLine: 55,
                    content: "The supervisor handles a crashed worker by reading the latest checkpoint and restarting the milestone."
                  }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            result: {
              status: "green",
              points_count: 42,
              vectors_count: 42,
              config: {
                params: {
                  vectors: {
                    size: 384
                  }
                }
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return originalFetch!(input, init);
  };
}

function maybeRestoreFetch() {
  if (!ollamaMockActive && !qdrantMockActive && originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

export function getFixtureDrawioSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1100" width="100%" height="100%" class="drawio-svg">
  <defs>
    <filter id="drawio-shadow" x="-10%" y="-10%" width="125%" height="125%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="1600" height="1100" fill="#ffffff" />
  <text x="50" y="50" font-size="20" font-weight="bold">local-agentic-sandbox: Architecture</text>
  <g class="drawio-node">
    <rect x="60" y="100" width="300" height="80" fill="#f8fafc" stroke="#64748b" />
    <text x="70" y="140">CLIENT &amp; INGRESS LAYER</text>
  </g>
  <g class="drawio-node">
    <rect x="60" y="220" width="300" height="80" fill="#f0f9ff" stroke="#0284c7" />
    <text x="70" y="260">KUBERNETES CLUSTER</text>
  </g>
  <g class="drawio-node">
    <rect x="60" y="340" width="300" height="80" fill="#fdf4ff" stroke="#a855f7" />
    <text x="70" y="380">HOST INFERENCE BOUNDARY</text>
  </g>
  <g class="drawio-node">
    <rect x="400" y="100" width="300" height="80" fill="#ffffff" stroke="#0369a1" />
    <text x="410" y="140">web-ui Orchestrator Pod</text>
  </g>
  <g class="drawio-node">
    <rect x="400" y="220" width="300" height="80" fill="#ffffff" stroke="#047857" />
    <text x="410" y="260">mcp-runner Tool Boundary</text>
  </g>
  <g class="drawio-node">
    <rect x="400" y="340" width="300" height="80" fill="#ffffff" stroke="#b45309" />
    <text x="410" y="380">browser-mcp Scraper Pod</text>
  </g>
  <g class="drawio-node">
    <rect x="740" y="100" width="300" height="80" fill="#ffffff" stroke="#475569" />
    <text x="750" y="140">builder-tier Toolchain Sandbox</text>
  </g>
  <g class="drawio-node">
    <rect x="740" y="220" width="300" height="80" fill="#ffffff" stroke="#0d9488" />
    <text x="750" y="260">qdrant-service: Qdrant Vector</text>
  </g>
  <g class="drawio-node">
    <rect x="740" y="340" width="300" height="80" fill="#ffffff" stroke="#4f46e5" />
    <text x="750" y="380">ollama-service</text>
  </g>
  <g class="drawio-node">
    <rect x="1080" y="100" width="250" height="60" fill="#d5e8d4" stroke="#82b366" />
    <text x="1090" y="135">ALB Load Balancer</text>
  </g>
  <g class="drawio-node">
    <rect x="1080" y="200" width="250" height="60" fill="#dae8fc" stroke="#6c8ebf" />
    <text x="1090" y="235">App Server</text>
  </g>
  <desc>${"Architecture Diagram Description Content Padding ".repeat(80)}</desc>
</svg>`;
}
