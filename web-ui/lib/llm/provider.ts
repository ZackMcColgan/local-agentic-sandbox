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
  options?: {
    temperature?: number;
    num_predict?: number;
    num_ctx?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface LLMProvider {
  engine: LLMEngine;
  streamChat(baseUrl: string, payload: LLMChatRequest): AsyncGenerator<LLMStreamChunk>;
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
      messages: payload.messages
    };

    if (payload.model) {
      requestBody.model = payload.model;
    }
    if (nKeep !== undefined) {
      requestBody.n_keep = nKeep;
    }
    if (payload.tools && payload.tools.length > 0) {
      requestBody.tools = payload.tools;
    }
    if (payload.options?.temperature !== undefined) {
      requestBody.temperature = payload.options.temperature;
    }
    if (payload.options?.num_predict !== undefined) {
      requestBody.max_tokens = payload.options.num_predict;
    }

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

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

          // Handle streaming delta content
          const content = choice.delta?.content;
          if (content) {
            yield {
              message: { content }
            };
          }

          // Handle streaming delta tool calls
          if (Array.isArray(choice.delta?.tool_calls)) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
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

          // Handle non-delta message tool calls
          if (Array.isArray(choice.message?.tool_calls)) {
            const normalizedMessageCalls = choice.message.tool_calls.map((tc: any) => {
              let args: any = tc.function?.arguments;
              if (typeof args === "string") {
                try {
                  args = JSON.parse(args);
                } catch {}
              }
              return {
                ...tc,
                function: {
                  ...tc.function,
                  arguments: args
                }
              };
            });
            yield {
              message: {
                role: choice.message.role || "assistant",
                content: choice.message.content || "",
                tool_calls: normalizedMessageCalls
              }
            };
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
}

export function getLLMProvider(engine?: string): LLMProvider {
  const resolved = resolveLLMEngine(engine);
  if (resolved === "llamacpp") {
    return new LlamaCppProvider();
  }
  return new OllamaProvider();
}
