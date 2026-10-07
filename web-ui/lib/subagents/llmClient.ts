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
}

export interface GenerateResult {
  text: string;
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
          stream: false,
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

    let data: any;
    try {
      data = await res.json();
    } catch (err: any) {
      throw new ModelUnavailableError(req.model, endpoint, `invalid JSON response: ${err?.message}`);
    }

    let text = typeof data?.response === "string" ? data.response.trim() : "";
    if (!text && !req.signal?.aborted) {
      // Transient model warm-up/context switch glitch in Ollama: wait 300ms and retry once
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const retryRes = await fetchImpl(endpoint, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: req.model,
            prompt: req.prompt,
            stream: false,
            ...(req.format ? { format: req.format } : {}),
            ...(req.keepAlive !== undefined ? { keep_alive: req.keepAlive } : {}),
            options: req.options || {}
          })
        });
        if (retryRes.ok) {
          const retryData = await retryRes.json();
          text = typeof retryData?.response === "string" ? retryData.response.trim() : "";
          if (text) {
            data = retryData;
          }
        }
      } catch (_) {}
    }

    if (!text) {
      throw new ModelUnavailableError(req.model, endpoint, "empty response");
    }

    const elapsed = Date.now() - startTime;
    console.log(`[llm] generate completed in ${elapsed}ms for model ${req.model}`);

    return {
      text,
      model: req.model,
      loadDurationMs: Math.round((data.load_duration || 0) / 1e6),
      totalDurationMs: Math.round((data.total_duration || 0) / 1e6)
    };
  };
}

/** True only when the test-only deterministic graph mode is explicitly enabled. */
export function isFastGraphTestMode(): boolean {
  return process.env.FAST_GRAPH_TEST === "1" || process.env.FAST_GRAPH_TEST === "true";
}

/** Strips markdown code fence, extracting inner code block if present. */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  // 1. If surrounded or containing a code block, extract the content of the block
  const match = trimmed.match(/```[a-zA-Z0-9_.+-]*\r?\n([\s\S]*?)\r?\n```/);
  if (match) {
    return match[1].trim();
  }
  // 2. Fallback for unclosed code fence at start
  const openMatch = trimmed.match(/^```[a-zA-Z0-9_.+-]*\r?\n([\s\S]*)$/);
  if (openMatch) {
    return openMatch[1].trim();
  }
  return trimmed;
}
