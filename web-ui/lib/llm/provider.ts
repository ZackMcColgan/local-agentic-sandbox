/**
 * LLM Provider Abstraction
 *
 * Provides a unified streaming interface for local inference engines:
 * - OllamaProvider: /api/chat NDJSON streaming
 * - LlamaCppProvider: /v1/chat/completions OpenAI-compatible SSE streaming with
 *   prompt-prefix protection (n_keep) and segmented tool call accumulation.
 */

import { estimateTokens } from "../contextBudget";

export type LLMEngine = "ollama" | "llamacpp";

export interface LLMStreamChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: any[];
  };
  done?: boolean;
  [key: string]: any;
}

export interface LLMChatRequest {
  model?: string;
  messages: any[];
  tools?: any[];
  keep_alive?: string | number;
  reasoning_effort?: "low" | "medium" | "xhigh";
  signal?: AbortSignal;
  options?: {
    temperature?: number;
    num_predict?: number;
    num_ctx?: number;
    reasoning_effort?: "low" | "medium" | "xhigh";
    [key: string]: any;
  };
  [key: string]: any;
}

export interface LLMGenerateRequest {
  model: string;
  prompt: string;
  format?: "json";
  options?: Record<string, unknown>;
  keepAlive?: string | number;
  signal?: AbortSignal;
  onThinkingChunk?: (chunk: string, totalThinking: string) => void;
  scope?: string;
  reasoningEffort?: string;
}

export interface LLMGenerateResult {
  text: string;
  thinking?: string;
  model: string;
  loadDurationMs?: number;
  totalDurationMs?: number;
  [key: string]: any;
}

export interface LLMProviderOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  scope?: string;
}

export interface LLMProvider {
  engine: LLMEngine;
  streamChat(baseUrl: string, payload: LLMChatRequest): AsyncGenerator<LLMStreamChunk>;
  chat(baseUrl: string, payload: LLMChatRequest): Promise<LLMStreamChunk>;
  generate(
    req: LLMGenerateRequest,
    baseUrl?: string,
    options?: LLMProviderOptions
  ): Promise<LLMGenerateResult>;
  listModels(baseUrl?: string, options?: LLMProviderOptions): Promise<string[]>;
  healthCheck(baseUrl?: string, options?: LLMProviderOptions): Promise<boolean>;
  ensureResident(model: string, baseUrl?: string, options?: LLMProviderOptions): Promise<boolean>;
}

export function resolveLLMEngine(envEngine?: string): LLMEngine {
  const raw = (envEngine ?? process.env.LLM_ENGINE ?? "").trim().toLowerCase();
  if (raw === "llamacpp") {
    return "llamacpp";
  }
  return "ollama";
}

export class OllamaProvider implements LLMProvider {
  engine: LLMEngine = "ollama";

  async *streamChat(baseUrl: string, payload: LLMChatRequest): AsyncGenerator<LLMStreamChunk> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama engine returned ${res.status}: ${errText}`);
    }

    if (!res.body) {
      throw new Error("Ollama returned empty response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const json = JSON.parse(trimmed);
            yield json;
          } catch (err) {
            console.warn("[Ollama Stream] JSON parse error on chunk:", trimmed);
          }
        }
      }

      if (buffer.trim()) {
        try {
          yield JSON.parse(buffer.trim());
        } catch {}
      }
    } finally {
      reader.releaseLock();
    }
  }

  async chat(baseUrl: string, payload: LLMChatRequest): Promise<LLMStreamChunk> {
    let accumulatedContent = "";
    let accumulatedThinking = "";
    const toolCalls: any[] = [];
    let lastChunk: LLMStreamChunk | undefined;

    for await (const chunk of this.streamChat(baseUrl, payload)) {
      lastChunk = chunk;
      if (chunk.message?.content) accumulatedContent += chunk.message.content;
      if (chunk.message?.thinking) accumulatedThinking += chunk.message.thinking;
      if (Array.isArray(chunk.message?.tool_calls)) toolCalls.push(...chunk.message.tool_calls);
    }

    return {
      ...lastChunk,
      message: {
        role: "assistant",
        content: accumulatedContent,
        ...(accumulatedThinking ? { thinking: accumulatedThinking } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      },
      done: true
    };
  }

  async generate(
    req: LLMGenerateRequest,
    baseUrl?: string,
    options?: LLMProviderOptions
  ): Promise<LLMGenerateResult> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (baseUrl || process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 900_000;
    const endpoint = `${effectiveBase}/api/generate`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

    const taskScope = req.scope || options?.scope;
    const numCtx = taskScope?.toUpperCase() === "PROJECT" ? 8192 : 4096;
    const requestedPredict = typeof req.options?.num_predict === "number" ? req.options.num_predict : 2048;
    const effort = (req.reasoningEffort || (req.options as any)?.reasoningEffort || "balanced") as string;
    let thinkingBudget = 4096;
    if (effort === "fast" || effort === "low") thinkingBudget = 1024;
    else if (effort === "deep" || effort === "xhigh") thinkingBudget = 8192;
    const effectiveNumPredict = requestedPredict + thinkingBudget;

    const requestOptions = {
      num_ctx: numCtx,
      ...(req.options || {}),
      num_predict: effectiveNumPredict
    };

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
          options: requestOptions
        })
      });
    } catch (err: any) {
      throw new Error(`Model "${req.model}" unavailable at ${endpoint}: ${err?.message || String(err)}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Model "${req.model}" unavailable at ${endpoint}: HTTP ${res.status} ${errText.slice(0, 200)}`);
    }

    let accumulatedText = "";
    let thinkingText = "";
    let insideThinking = false;
    let loadDurationMs = 0;
    let totalDurationMs = 0;

    if (res.body && typeof (res.body as any).getReader === "function") {
      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      try {
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

              if (part.includes("<think>")) insideThinking = true;
              if (insideThinking && !part.includes("</think>")) {
                thinkingText += part;
                req.onThinkingChunk?.(part, thinkingText);
              } else if (insideThinking && part.includes("</think>")) {
                const [beforeClosing] = part.split("</think>");
                thinkingText += beforeClosing || "";
                insideThinking = false;
                if (beforeClosing) req.onThinkingChunk?.(beforeClosing, thinkingText);
              }
            } catch (_) {}
          }
        }

        if (buffer.trim()) {
          try {
            const chunk = JSON.parse(buffer);
            if (chunk.load_duration) loadDurationMs = Math.round(chunk.load_duration / 1e6);
            if (chunk.total_duration) totalDurationMs = Math.round(chunk.total_duration / 1e6);
            const part = chunk.response || "";
            accumulatedText += part;
          } catch (_) {
            accumulatedText += buffer;
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
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

    const text = accumulatedText.trim();
    if (!text) {
      throw new Error(`Model "${req.model}" unavailable at ${endpoint}: empty response`);
    }

    return {
      text,
      thinking: thinkingText.trim() || undefined,
      model: req.model,
      loadDurationMs,
      totalDurationMs
    };
  }

  async listModels(baseUrl?: string, options?: LLMProviderOptions): Promise<string[]> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (baseUrl || process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 5000;
    const res = await fetchImpl(`${effectiveBase}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      throw new Error(`Ollama listModels failed: HTTP ${res.status}`);
    }
    const data: any = await res.json();
    return (data.models || []).map((m: any) => m.name || "").filter(Boolean);
  }

  async healthCheck(baseUrl?: string, options?: LLMProviderOptions): Promise<boolean> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (baseUrl || process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 5000;
    try {
      const res = await fetchImpl(`${effectiveBase}/api/version`, {
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureResident(model: string, baseUrl?: string, options?: LLMProviderOptions): Promise<boolean> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (baseUrl || process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 30_000;
    try {
      const res = await fetchImpl(`${effectiveBase}/api/generate`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: -1 })
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Normalizes conversation messages for OpenAI-compatible engines (/v1/chat/completions):
 * 1. Consolidates any stray role === "system" at index > 0 into index 0.
 * 2. Normalizes assistant tool_calls: ensures id, type: "function", and arguments as JSON string.
 * 3. Assigns matching tool_call_id to subsequent role === "tool" messages.
 */
export function normalizeOpenAIMessages(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // 1. Consolidate stray system messages into index 0
  let consolidatedSystem = "";
  const hasLeadingSystem = messages[0]?.role === "system";
  if (hasLeadingSystem) {
    consolidatedSystem = typeof messages[0].content === "string" ? messages[0].content : JSON.stringify(messages[0].content || "");
  }

  const nonSystem: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i === 0 && hasLeadingSystem) continue;
    if (m?.role === "system") {
      const extra = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      if (extra.trim() && !consolidatedSystem.includes(extra.trim())) {
        consolidatedSystem = consolidatedSystem ? `${consolidatedSystem}\n\n${extra.trim()}` : extra.trim();
      }
    } else {
      nonSystem.push(m);
    }
  }

  const reordered: any[] = [];
  if (hasLeadingSystem || consolidatedSystem) {
    reordered.push({ role: "system", content: consolidatedSystem });
  }
  reordered.push(...nonSystem);

  // Guarantee at least one role === "user" message exists so strict Jinja templates
  // (e.g. Qwen/Swift multi-step tools) never throw "No user query found in messages"
  const hasUserMessage = reordered.some(
    (m) =>
      m?.role === "user" &&
      ((typeof m?.content === "string" && m.content.trim().length > 0) ||
        (Array.isArray(m?.content) && m.content.length > 0) ||
        (Array.isArray(m?.images) && m.images.length > 0))
  );
  if (!hasUserMessage) {
    const insertIdx = reordered.length > 0 && reordered[0]?.role === "system" ? 1 : 0;
    reordered.splice(insertIdx, 0, { role: "user", content: "Proceed with the request." });
  }

  // 2. Track tool calls, convert multimodal images, and assign IDs
  const pendingToolCallIds: string[] = [];
  return reordered.map((msg, msgIdx) => {
    let currentMsg = msg;

    // Convert Ollama-format images array into OpenAI multimodal content parts
    if (Array.isArray(currentMsg?.images) && currentMsg.images.length > 0) {
      const parts: any[] = [];
      if (typeof currentMsg.content === "string" && currentMsg.content.length > 0) {
        parts.push({ type: "text", text: currentMsg.content });
      } else if (Array.isArray(currentMsg.content)) {
        parts.push(...currentMsg.content);
      } else {
        parts.push({ type: "text", text: "" });
      }

      for (const img of currentMsg.images) {
        if (!img || typeof img !== "string") continue;
        const url = img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
        parts.push({
          type: "image_url",
          image_url: { url }
        });
      }

      const { images, ...rest } = currentMsg;
      currentMsg = {
        ...rest,
        content: parts
      };
    }

    if (currentMsg?.role === "assistant" && Array.isArray(currentMsg.tool_calls) && currentMsg.tool_calls.length > 0) {
      pendingToolCallIds.length = 0; // reset for this assistant turn
      const normalizedCalls = currentMsg.tool_calls.map((tc: any, tcIdx: number) => {
        const id = tc.id || `call_${msgIdx}_${tcIdx}`;
        pendingToolCallIds.push(id);
        const rawArgs = tc.function?.arguments;
        const argsStr = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
        return {
          id,
          type: "function",
          function: {
            name: tc.function?.name || "unknown",
            arguments: argsStr
          }
        };
      });
      return {
        ...currentMsg,
        content: currentMsg.content ?? "",
        tool_calls: normalizedCalls
      };
    }

    if (currentMsg?.role === "tool") {
      const matchedId = currentMsg.tool_call_id || pendingToolCallIds.shift() || `call_${msgIdx}_0`;
      return {
        ...currentMsg,
        tool_call_id: matchedId,
        content: typeof currentMsg.content === "string" ? currentMsg.content : JSON.stringify(currentMsg.content ?? "")
      };
    }

    return currentMsg;
  });
}

export class LlamaCppProvider implements LLMProvider {
  engine: LLMEngine = "llamacpp";

  async *streamChat(baseUrl: string, payload: LLMChatRequest): AsyncGenerator<LLMStreamChunk> {
    const effectiveBase = (process.env.LLAMACPP_BASE_URL || baseUrl).replace(/\/$/, "");
    const targetUrl = `${effectiveBase}/v1/chat/completions`;

    // Prompt-prefix protection: compute n_keep so llama-server never evicts system prompt
    let nKeep: number | undefined;
    if (payload.messages?.[0]?.role === "system") {
      const systemContent = payload.messages[0].content || "";
      const tokens = estimateTokens(systemContent);
      nKeep = Math.min(2048, Math.max(64, tokens));
    }

    const requestBody: Record<string, any> = {
      stream: true,
      messages: normalizeOpenAIMessages(payload.messages || [])
    };

    if (payload.model) {
      requestBody.model = payload.model;
    }
    if (nKeep !== undefined) {
      requestBody.n_keep = nKeep;
    }
    if (payload.tools && payload.tools.length > 0) {
      requestBody.tools = payload.tools;
      requestBody.parallel_tool_calls = false;
    }
    if (payload.options?.temperature !== undefined) {
      requestBody.temperature = payload.options.temperature;
    }
    if (payload.options?.num_predict !== undefined) {
      requestBody.max_tokens = payload.options.num_predict;
    }
    const effort = payload.reasoning_effort || payload.options?.reasoning_effort;
    if (effort) {
      requestBody.reasoning_effort = effort;
    }

    let res: Response;
    try {
      res = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: payload.signal
      });
    } catch (err: any) {
      if (payload.signal?.aborted || err?.name === "AbortError") {
        throw err;
      }
      const cleanBase = (baseUrl || "").replace(/\/$/, "");
      if (effectiveBase !== cleanBase && cleanBase) {
        const fallbackUrl = `${cleanBase}/v1/chat/completions`;
        try {
          res = await fetch(fallbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: payload.signal
          });
        } catch {
          throw new Error(`llama.cpp engine returned network error at ${targetUrl}: ${err?.message || String(err)}`);
        }
      } else {
        throw new Error(`llama.cpp engine returned network error at ${targetUrl}: ${err?.message || String(err)}`);
      }
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`llama.cpp engine returned ${res.status}: ${errText}`);
    }

    if (!res.body) {
      throw new Error("llama.cpp returned empty response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const toolCallsAccumulator: Map<
      number,
      { id?: string; type?: string; function: { name: string; arguments: string } }
    > = new Map();

    let insideThinking = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.replace(/^data:\s*/, "");
          if (dataStr === "[DONE]") {
            break;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(dataStr);
          } catch {
            continue;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          // Handle streaming delta reasoning
          const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
          if (reasoning) {
            yield {
              message: { thinking: reasoning }
            };
          }

          // Handle streaming delta content with inline <think> tags separation
          let content = choice.delta?.content;
          if (content) {
            if (!insideThinking && content.includes("<think>")) {
              const parts = content.split("<think>");
              if (parts[0]) {
                yield { message: { content: parts[0] } };
              }
              insideThinking = true;
              content = parts.slice(1).join("<think>");
            }

            if (insideThinking) {
              if (content.includes("</think>")) {
                const parts = content.split("</think>");
                if (parts[0]) {
                  yield { message: { thinking: parts[0] } };
                }
                insideThinking = false;
                const after = parts.slice(1).join("</think>");
                if (after) {
                  yield { message: { content: after } };
                }
              } else if (content) {
                yield { message: { thinking: content } };
              }
            } else if (content) {
              yield { message: { content } };
            }
          }

          // Handle streaming delta tool calls
          if (Array.isArray(choice.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              // Guard against runaway multi-index degenerate loops: only track primary tool call (index 0)
              if (idx > 0) continue;
              if (!toolCallsAccumulator.has(idx)) {
                toolCallsAccumulator.set(idx, {
                  id: tc.id || "",
                  type: tc.type || "function",
                  function: { name: "", arguments: "" }
                });
              }
              const acc = toolCallsAccumulator.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.type) acc.type = tc.type;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
            }
          }

          // Handle non-delta message tool calls: accumulate into toolCallsAccumulator, do NOT yield on every chunk!
          if (Array.isArray(choice.message?.tool_calls)) {
            for (let i = 0; i < choice.message.tool_calls.length; i++) {
              const tc = choice.message.tool_calls[i];
              const idx = tc.index ?? i;
              if (!toolCallsAccumulator.has(idx)) {
                toolCallsAccumulator.set(idx, {
                  id: tc.id || "",
                  type: tc.type || "function",
                  function: { name: "", arguments: "" }
                });
              }
              const acc = toolCallsAccumulator.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.type) acc.type = tc.type;
              if (tc.function?.name) acc.function.name = tc.function.name;
              const rawArgs = tc.function?.arguments;
              if (typeof rawArgs === "string" && rawArgs.length > acc.function.arguments.length) {
                acc.function.arguments = rawArgs;
              } else if (rawArgs && typeof rawArgs === "object") {
                acc.function.arguments = JSON.stringify(rawArgs);
              }
            }
          }
        }
      }

      // End of stream: emit accumulated streaming tool calls if any
      if (toolCallsAccumulator.size > 0) {
        const finalizedToolCalls = Array.from(toolCallsAccumulator.values()).map((tc) => {
          let args: any = tc.function.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {}
          }
          return {
            id: tc.id || undefined,
            type: tc.type || "function",
            function: {
              name: tc.function.name,
              arguments: args
            }
          };
        });

        yield {
          message: {
            role: "assistant",
            tool_calls: finalizedToolCalls
          },
          done: true
        };
      } else {
        yield { done: true };
      }
    } finally {
      reader.releaseLock();
    }
  }

  async chat(baseUrl: string, payload: LLMChatRequest): Promise<LLMStreamChunk> {
    let accumulatedContent = "";
    let accumulatedThinking = "";
    const toolCalls: any[] = [];
    let lastChunk: LLMStreamChunk | undefined;

    for await (const chunk of this.streamChat(baseUrl, payload)) {
      lastChunk = chunk;
      if (chunk.message?.content) accumulatedContent += chunk.message.content;
      if (chunk.message?.thinking) accumulatedThinking += chunk.message.thinking;
      if (Array.isArray(chunk.message?.tool_calls)) toolCalls.push(...chunk.message.tool_calls);
    }

    return {
      ...lastChunk,
      message: {
        role: "assistant",
        content: accumulatedContent,
        ...(accumulatedThinking ? { thinking: accumulatedThinking } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      },
      done: true
    };
  }

  async generate(
    req: LLMGenerateRequest,
    baseUrl?: string,
    options?: LLMProviderOptions
  ): Promise<LLMGenerateResult> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (process.env.LLAMACPP_BASE_URL || baseUrl || "http://127.0.0.1:8080").replace(/\/$/, "");
    const targetUrl = `${effectiveBase}/v1/chat/completions`;
    const timeoutMs = options?.timeoutMs || 900_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

    // Prompt-prefix protection: compute n_keep so llama-server never evicts prompt context
    let nKeep: number | undefined = typeof req.options?.n_keep === "number" ? req.options.n_keep : undefined;
    if (nKeep === undefined && req.prompt) {
      const tokens = estimateTokens(req.prompt.slice(0, 500));
      nKeep = Math.min(2048, Math.max(64, tokens));
    }

    // Decouple reasoning token budget from generated output budget:
    // When using models with thinking tokens, max_tokens in llama-server limits BOTH reasoning and content.
    // Allocate requested output tokens PLUS reasoning headroom so thinking never starves completion.
    const effort = req.reasoningEffort || (req.options as any)?.reasoningEffort;
    let maxTokens: number;
    if (typeof req.options?.max_tokens === "number") {
      maxTokens = req.options.max_tokens;
    } else if (effort) {
      const requestedPredict = typeof req.options?.num_predict === "number" ? req.options.num_predict : 2048;
      let thinkingBudget = 4096;
      if (effort === "fast" || effort === "low") thinkingBudget = 1024;
      else if (effort === "deep" || effort === "xhigh") thinkingBudget = 8192;
      maxTokens = requestedPredict + thinkingBudget;
    } else if (typeof req.options?.num_predict === "number") {
      maxTokens = req.options.num_predict;
    } else {
      maxTokens = 6144;
    }

    const requestBody: Record<string, any> = {
      model: req.model,
      messages: normalizeOpenAIMessages([{ role: "user", content: req.prompt }]),
      stream: true,
      max_tokens: maxTokens
    };

    if (nKeep !== undefined) {
      requestBody.n_keep = nKeep;
    }
    if (req.options?.temperature !== undefined) {
      requestBody.temperature = req.options.temperature;
    }

    const startTime = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(targetUrl, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
    } catch (err: any) {
      const cleanBase = (baseUrl || "").replace(/\/$/, "");
      if (effectiveBase !== cleanBase && cleanBase) {
        const fallbackUrl = `${cleanBase}/v1/chat/completions`;
        try {
          res = await fetchImpl(fallbackUrl, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          });
        } catch {
          throw new Error(`Model "${req.model}" unavailable at ${targetUrl}: ${err?.message || String(err)}`);
        }
      } else {
        throw new Error(`Model "${req.model}" unavailable at ${targetUrl}: ${err?.message || String(err)}`);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Model "${req.model}" unavailable at ${targetUrl}: HTTP ${res.status} ${errText.slice(0, 200)}`);
    }

    let accumulatedText = "";
    let thinkingText = "";
    let insideThinking = false;

    if (res.body && typeof (res.body as any).getReader === "function") {
      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.replace(/^data:\s*/, "");
            if (dataStr === "[DONE]") break;

            let parsed: any;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
            if (reasoning) {
              thinkingText += reasoning;
              req.onThinkingChunk?.(reasoning, thinkingText);
            }

            const content = choice.delta?.content;
            if (content) {
              accumulatedText += content;
              if (content.includes("<think>")) insideThinking = true;
              if (insideThinking && !content.includes("</think>")) {
                thinkingText += content;
                req.onThinkingChunk?.(content, thinkingText);
              } else if (insideThinking && content.includes("</think>")) {
                const [beforeClosing] = content.split("</think>");
                thinkingText += beforeClosing || "";
                insideThinking = false;
                if (beforeClosing) req.onThinkingChunk?.(beforeClosing, thinkingText);
              }
            }
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      const rawText = await res.text();
      const lines = rawText.split("\n").filter((l) => l.trim().startsWith("data:"));
      for (const line of lines) {
        const dataStr = line.replace(/^data:\s*/, "").trim();
        if (dataStr === "[DONE]") break;
        try {
          const parsed = JSON.parse(dataStr);
          const choice = parsed.choices?.[0];
          if (choice) {
            const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
            if (reasoning) {
              thinkingText += reasoning;
              req.onThinkingChunk?.(reasoning, thinkingText);
            }
            const content = choice.delta?.content;
            if (content) accumulatedText += content;
          }
        } catch {}
      }
    }

    let text = accumulatedText.trim();
    if (!text && thinkingText.trim()) {
      // If the model produced reasoning but content is empty, check if it placed code or JSON within the reasoning stream
      const rawThinking = thinkingText.trim();
      const codeBlockMatch = rawThinking.match(/```(?:json|xml|svg|typescript|javascript|ts|js)?\s*([\s\S]*?)```/);
      const jsonObjectMatch = rawThinking.match(/(\{(?:[\s\S]*"milestones"[\s\S]*|"approved"[\s\S]*)\})/);
      if (codeBlockMatch && codeBlockMatch[1]?.trim()) {
        text = codeBlockMatch[1].trim();
      } else if (jsonObjectMatch && jsonObjectMatch[1]?.trim()) {
        text = jsonObjectMatch[1].trim();
      } else {
        text = rawThinking;
      }
    }

    if (!text) {
      throw new Error(`Model "${req.model}" unavailable at ${targetUrl}: empty response`);
    }

    return {
      text,
      thinking: thinkingText.trim() || undefined,
      model: req.model,
      totalDurationMs: Date.now() - startTime
    };
  }

  async listModels(baseUrl?: string, options?: LLMProviderOptions): Promise<string[]> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (process.env.LLAMACPP_BASE_URL || baseUrl || "http://127.0.0.1:8080").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 5000;
    const res = await fetchImpl(`${effectiveBase}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      throw new Error(`llama.cpp listModels failed: HTTP ${res.status}`);
    }
    const data: any = await res.json();
    return (data.data || []).map((m: any) => m.id || m.name || "").filter(Boolean);
  }

  async healthCheck(baseUrl?: string, options?: LLMProviderOptions): Promise<boolean> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (process.env.LLAMACPP_BASE_URL || baseUrl || "http://127.0.0.1:8080").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 5000;
    try {
      const res = await fetchImpl(`${effectiveBase}/health`, {
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureResident(model: string, baseUrl?: string, options?: LLMProviderOptions): Promise<boolean> {
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const effectiveBase = (process.env.LLAMACPP_BASE_URL || baseUrl || "http://127.0.0.1:8080").replace(/\/$/, "");
    const timeoutMs = options?.timeoutMs || 15000;
    try {
      const res = await fetchImpl(`${effectiveBase}/health`, {
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function getLLMProvider(engine?: string): LLMProvider {
  const resolved = resolveLLMEngine(engine);
  if (resolved === "llamacpp") {
    return new LlamaCppProvider();
  }
  return new OllamaProvider();
}
