import { isReasoningEffortSupported, getModelProfile } from "@/config/models";

export interface ModelOptions {
  num_ctx: number;
  temperature?: number;
  num_predict?: number;
  top_p?: number;
  top_k?: number;
  [key: string]: any;
}

/**
 * Resolves the effective reasoning effort applied to a model.
 * If the model does not support reasoning effort (e.g. Hermes 3), returns undefined.
 */
export function resolveEffectiveReasoningEffort(
  modelToUse: string,
  requestedEffort?: "low" | "medium" | "xhigh"
): "low" | "medium" | "xhigh" | undefined {
  if (!isReasoningEffortSupported(modelToUse)) {
    return undefined;
  }
  const profile = getModelProfile(modelToUse);
  return requestedEffort || profile?.defaultReasoningEffort || "medium";
}

/**
 * Computes options for Ollama model request based on model architecture and reasoning effort.
 */
export function computeModelOptions(
  modelToUse: string,
  reasoningEffort?: "low" | "medium" | "xhigh"
): ModelOptions {
  const opts: ModelOptions = {
    num_ctx: modelToUse.includes("gemma4") ? 16384 : 8192
  };

  const effectiveEffort = resolveEffectiveReasoningEffort(modelToUse, reasoningEffort);

  if (effectiveEffort === "low") {
    opts.temperature = 0.2;
    opts.num_predict = 4096;
  } else if (effectiveEffort === "xhigh") {
    opts.temperature = 0.7;
    opts.num_predict = 8192;
  } else if (effectiveEffort === "medium") {
    opts.temperature = 0.5;
    opts.num_predict = 4096;
  } else {
    // For models without reasoning effort support (e.g. Hermes 3), use standard unbiased defaults
    opts.temperature = 0.7;
    opts.num_predict = 4096;
  }

  return opts;
}

/**
 * Parses raw assistant stream content extracting complete or in-progress <think>...</think> reasoning blocks.
 */
export function parseThinkingAndContent(raw: string): { thought?: string; content: string } {
  if (!raw) return { content: "" };

  const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
  const match = raw.match(thinkRegex);
  if (match) {
    const thought = match[1].trim();
    const content = raw.replace(thinkRegex, "").trim();
    return { thought, content };
  }

  if (raw.includes("<think>")) {
    const parts = raw.split(/<think>/i);
    const beforeThink = parts[0];
    const afterThink = parts.slice(1).join("<think>");
    if (afterThink.includes("</think>")) {
      const sub = afterThink.split(/<\/think>/i);
      return {
        thought: sub[0].trim(),
        content: (beforeThink + "\n" + sub.slice(1).join("</think>")).trim()
      };
    } else {
      return {
        thought: afterThink,
        content: beforeThink.trim()
      };
    }
  }

  return { content: raw };
}
