/**
 * Shared model client for worker roles (planner / builder / critic).
 *
 * Contract: a call either returns real model text or throws ModelUnavailableError.
 * There is no silent fallback here — callers decide how to fail (critic abstains,
 * builder/planner fail loudly). See docs/MODEL_RESIDENCY.md for keep_alive policy.
 */

export interface GenerateRequest {
  model: string;
  prompt: string;
  format?: "json";
  options?: Record<string, unknown>;
  /** Ollama keep_alive value (e.g. "30m", 0, -1). Supplied by the residency policy. */
  keepAlive?: string | number;
  signal?: AbortSignal;
  onThinkingChunk?: (chunk: string, totalThinking: string) => void;
}

export interface GenerateResult {
  text: string;
  thinking?: string;
  model: string;
  /** Time Ollama spent loading weights for this call (ms). >~1000ms means a cold load. */
  loadDurationMs: number;
  totalDurationMs: number;
}

export type GenerateFn = (req: GenerateRequest) => Promise<GenerateResult>;

export class ModelUnavailableError extends Error {
  readonly model: string;
  readonly endpoint: string;
  constructor(model: string, endpoint: string, reason: string) {
    super(`Model "${model}" unavailable at ${endpoint}: ${reason}`);
    this.name = "ModelUnavailableError";
    this.model = model;
    this.endpoint = endpoint;
  }
}

export function resolveOllamaBaseUrl(explicit?: string): string {
  let url = explicit || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `http://${url}`;
  }
  return url;
}

export function resolveWorkerTimeoutMs(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const fromEnv = Number(process.env.WORKER_MODEL_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 900_000;
}

/**
 * Creates a GenerateFn bound to an Ollama endpoint.
 * Network errors, non-2xx responses, timeouts and empty responses all throw ModelUnavailableError.
 */
export function createOllamaGenerate(options?: {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): GenerateFn {
  const baseUrl = resolveOllamaBaseUrl(options?.baseUrl);
  const timeoutMs = resolveWorkerTimeoutMs(options?.timeoutMs);
  const fetchImpl = options?.fetchImpl || fetch;

  return async (req: GenerateRequest): Promise<GenerateResult> => {
    const startTime = Date.now();
    const endpoint = `${baseUrl}/api/generate`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          prompt: req.prompt,
          stream: true,
          ...(req.format ? { format: req.format } : {}),
          ...(req.keepAlive !== undefined ? { keep_alive: req.keepAlive } : {}),
          options: req.options || {}
        })
      });
    } catch (err: any) {
      throw new ModelUnavailableError(req.model, endpoint, err?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err?.message || String(err));
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ModelUnavailableError(req.model, endpoint, `HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    let accumulatedText = "";
    let thinkingText = "";
    // swift-27b-mtp begins streaming its chain-of-thought immediately and terminates it with </think>
    let insideThinking = true;
    let loadDurationMs = 0;
    let totalDurationMs = 0;
    let lastLogTime = Date.now();

    try {
      if (res.body && typeof (res.body as any).getReader === "function") {
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              if (chunk.load_duration) loadDurationMs = Math.round(chunk.load_duration / 1e6);
              if (chunk.total_duration) totalDurationMs = Math.round(chunk.total_duration / 1e6);
              const part = chunk.response || "";
              accumulatedText += part;

              // Track thinking state (swift-27b-mtp starts streaming thinking immediately before closing with </think>)
              if (part.includes("<think>")) insideThinking = true;
              if (insideThinking && !part.includes("</think>")) {
                thinkingText += part;
                if (req.onThinkingChunk) {
                  try {
                    req.onThinkingChunk(part, thinkingText);
                  } catch (_) {}
                }
              } else if (insideThinking && part.includes("</think>")) {
                const [beforeClosing] = part.split("</think>");
                thinkingText += beforeClosing || "";
                insideThinking = false;
                if (req.onThinkingChunk && beforeClosing) {
                  try {
                    req.onThinkingChunk(beforeClosing, thinkingText);
                  } catch (_) {}
                }
                console.log(`[llm] thinking finished (${thinkingText.length} chars)`);
              }

              const now = Date.now();
              if (now - lastLogTime >= 15000) {
                lastLogTime = now;
                const elapsedSec = Math.round((now - startTime) / 1000);
                if (insideThinking || (!accumulatedText.includes("</think>") && accumulatedText.length > 0 && !accumulatedText.includes("```"))) {
                  const sample = (thinkingText || accumulatedText).replace(/\r?\n/g, " ").trim().slice(-120);
                  console.log(`[llm] stream thinking [${elapsedSec}s elapsed]: ...${sample}`);
                } else {
                  console.log(`[llm] stream generating [${elapsedSec}s elapsed, ${accumulatedText.length} chars accumulated]`);
                }
              }
            } catch (_) {}
          }
        }
      } else {
        // Fallback for non-stream or custom mock fetchImpl
        const rawText = await res.text();
        const lines = rawText.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const chunk = JSON.parse(line);
            accumulatedText += chunk.response || "";
            if (chunk.load_duration) loadDurationMs = Math.round(chunk.load_duration / 1e6);
            if (chunk.total_duration) totalDurationMs = Math.round(chunk.total_duration / 1e6);
          } catch {
            accumulatedText += line;
          }
        }
      }
    } catch (err: any) {
      throw new ModelUnavailableError(req.model, endpoint, `stream read error: ${err?.message || String(err)}`);
    }

    let text = accumulatedText.trim();
    if (!text) {
      throw new ModelUnavailableError(req.model, endpoint, "empty response");
    }

    const elapsed = Date.now() - startTime;
    console.log(`[llm] generate completed in ${elapsed}ms for model ${req.model} (${text.length} chars)`);

    return {
      text,
      thinking: thinkingText.trim() || undefined,
      model: req.model,
      loadDurationMs,
      totalDurationMs: totalDurationMs || elapsed
    };
  };
}

/** True only when the test-only deterministic graph mode is explicitly enabled. */
export function isFastGraphTestMode(): boolean {
  return process.env.FAST_GRAPH_TEST === "1" || process.env.FAST_GRAPH_TEST === "true";
}

/** Strips markdown code fence and thinking blocks, extracting inner code block if present. */
export function stripCodeFence(raw: string): string {
  let cleaned = raw.trim();

  // 1. Strip completed <think>...</think> blocks
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. Strip orphan leading reasoning up to </think>
  if (cleaned.includes("</think>")) {
    cleaned = cleaned.substring(cleaned.indexOf("</think>") + 8).trim();
  }

  // 3. If surrounded or containing a code block, extract the content of the block
  const match = cleaned.match(/```[a-zA-Z0-9_.+-]*\r?\n([\s\S]*?)\r?\n```/);
  if (match) {
    return match[1].trim();
  }

  // 4. Fallback for unclosed code fence
  const openMatch = cleaned.match(/```[a-zA-Z0-9_.+-]*\r?\n([\s\S]*)$/);
  if (openMatch) {
    return openMatch[1].trim();
  }

  return cleaned;
}
