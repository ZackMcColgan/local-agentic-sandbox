import { isReasoningEffortSupported, getModelProfile } from "../config/models";

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

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 131072;

/**
 * Computes options for local LLM model request based on model architecture and reasoning effort.
 */
export function computeModelOptions(
  modelToUse: string,
  reasoningEffort?: "low" | "medium" | "xhigh"
): ModelOptions {
  const opts: ModelOptions = {
    num_ctx: DEFAULT_CONTEXT_WINDOW_TOKENS
  };

  const effectiveEffort = resolveEffectiveReasoningEffort(modelToUse, reasoningEffort);

  if (effectiveEffort === "low") {
    opts.temperature = 0.2;
    opts.num_predict = 16384;
  } else if (effectiveEffort === "xhigh") {
    opts.temperature = 0.7;
    opts.num_predict = 16384;
  } else if (effectiveEffort === "medium") {
    opts.temperature = 0.5;
    opts.num_predict = 16384;
  } else {
    // For models without reasoning effort support (e.g. Hermes 3), use standard unbiased defaults
    opts.temperature = 0.7;
    opts.num_predict = 16384;
  }

  return opts;
}

/**
 * Checks if the user's prompt references codebase, architectural, or repository concepts.
 * General conversational questions (weather, greetings, trivia) bypass cold RAG lookups.
 */
export function shouldConsultLocalOracle(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return /\b(repo|codebase|file|function|class|test|supervisor|worker|critic|planner|ledger|mcp|qdrant|k8s|kubernetes|docker|deploy|sandbox|morning report|\.ts|\.tsx|\.js|\.py|\.md|\.yaml)\b/i.test(prompt);
}

/**
 * Parses raw assistant stream content extracting complete or in-progress <think>...</think> reasoning blocks.
 */
export function parseThinkingAndContent(raw: string): { thought?: string; content: string } {
  if (!raw) return { content: "" };

  const thoughts: string[] = [];
  let working = raw;

  // 1. Extract all complete <think>...</think> blocks
  working = working.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, inner) => {
    if (inner && inner.trim()) thoughts.push(inner.trim());
    return "";
  });

  // 2. Handle orphan leading reasoning terminated by </think> (swift-15-27b-mtp pattern)
  if (working.includes("</think>")) {
    const idx = working.indexOf("</think>");
    const before = working.slice(0, idx).replace(/<think>/gi, "").trim();
    if (before) thoughts.push(before);
    working = working.slice(idx + "</think>".length);
  }

  // 3. Handle in-progress unclosed <think> block during live streaming
  if (/<\s*think\s*>/i.test(working)) {
    const parts = working.split(/<\s*think\s*>/i);
    const beforeThink = parts[0].trim();
    const inProgressThought = parts.slice(1).join("").trim();
    if (inProgressThought) thoughts.push(inProgressThought);
    working = beforeThink;
  }

  // 4. Strip any residual <tool_call>...</tool_call> or <function=...> XML tags from visible content
  working = working
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*$/gi, "")
    .replace(/<\/?function[^>]*>/gi, "")
    .trim();

  const combinedThought = thoughts.join("\n\n").trim();
  return {
    thought: combinedThought.length > 0 ? combinedThought : undefined,
    content: working
  };
}

/**
 * Formats duration in seconds to clean human-readable string (e.g. "45s", "3m 12s", "1h 1m 5s").
 */
export function formatElapsedDuration(totalSeconds: number): string {
  if (totalSeconds < 0) totalSeconds = 0;
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

/**
 * Filters out raw SVG/XML coordinates, code dumps, and repetitive noise from thinking narratives,
 * preserving clean, human-readable reasoning steps.
 */
export function formatThinkingDisplay(entries: string[]): string[] {
  if (!entries || !Array.isArray(entries)) return [];

  const cleanedSteps: string[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    if (!raw || typeof raw !== "string") continue;
    let text = raw.trim();

    // Strip out markdown code fences and their contents if it's purely a code/xml dump
    if (text.startsWith("```") && text.endsWith("```")) {
      continue;
    }

    // Filter out raw SVG tags or coordinate dumps (e.g. <svg..., <path d=..., <rect x=...)
    if (/<(svg|path|rect|circle|g|line|defs|linearGradient|text|filter)\b[^>]*>/i.test(text)) {
      continue;
    }

    // Clean up "Analyzing:" prefix from live streaming updates
    if (text.startsWith("Analyzing:")) {
      text = text.replace(/^Analyzing:\s*/, "");
    }

    // Clean repetitive prompt instructions or system prompt quotes
    if (/^(we need answer user's request|need generate only|generate only file content)/i.test(text)) {
      continue;
    }

    // Suppress meta-formatting noise (code fence syntax, counts, structural fences, etc.)
    // Examples: "in a ``` typescript (or appropriate language) code fence", "two fences", "separated by markers", "No intro", "Alternative: output a single..."
    if (
      /\b(code fence|code fences|two fences|single code fence|fences\b|separated by markers|no intro\b|no introductory|introductory or concluding|closing fence|markdown fence)\b/i.test(text) ||
      /\b(alternative:\s*output|output a single code fence|enclose(d)? in a (```|markdown)|appropriate language\) code fence)/i.test(text) ||
      /^in a\s+```/i.test(text)
    ) {
      continue;
    }

    // Clean stray leading/trailing quotes or punctuation often present in token streaming fragments
    text = text.replace(/^["'`\s]+/, "").replace(/["'`\s]+$/, "");

    // Deduplicate
    const normalized = text.toLowerCase();
    if (!seen.has(normalized) && text.length > 0) {
      seen.add(normalized);
      cleanedSteps.push(text);
    }
  }

  return cleanedSteps;
}

export interface HumanReadableTrace {
  title: string;
  duration: string;
  badge: "sandbox" | "browser" | "workspace" | "host";
}

/**
 * Translates technical MCP tool names and timings into plain language descriptions.
 */
export function formatHumanReadableTrace(trace: {
  tool: string;
  durationMs?: number;
  args?: any;
  tier?: "sandbox" | "browser" | "workspace" | "host" | string;
}): HumanReadableTrace {
  const durationSec = trace.durationMs ? (trace.durationMs / 1000).toFixed(1) + "s" : "";
  const durationFormatted = trace.durationMs ? (trace.durationMs < 1000 ? `${trace.durationMs}ms` : durationSec) : "";

  const tool = trace.tool || "";
  let title = tool;
  let badge: "sandbox" | "browser" | "workspace" | "host" = "sandbox";

  if (trace.tier === "host" || tool.startsWith("host_")) {
    badge = "host";
    if (tool === "host_run_powershell") {
      const cmd = trace.args?.command ? ` (${trace.args.command.slice(0, 24)})` : "";
      title = `Ran host PowerShell${cmd}`;
    } else if (tool === "host_read_file") {
      const p = trace.args?.path || trace.args?.filePath || "";
      const filename = p ? p.split(/[\\/]/).pop() || p : "";
      title = filename ? `Host Read ${filename}` : "Host Read File";
    } else if (tool === "host_write_file") {
      const p = trace.args?.path || trace.args?.filePath || "";
      const filename = p ? p.split(/[\\/]/).pop() || p : "";
      title = filename ? `Host Wrote ${filename}` : "Host Wrote File";
    } else if (tool === "host_list_dir") {
      title = "Host List Dir";
    } else if (tool === "host_delete_path") {
      title = "Host Delete Path";
    } else {
      title = tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  } else if (tool === "search_web" || tool.includes("search")) {
    const q = trace.args?.query ? ` for "${trace.args.query.slice(0, 30)}"` : "";
    title = `Searched the web${q}`;
    badge = "browser";
  } else if (tool === "fetch_web_page" || tool.includes("browser") || tool.includes("fetch")) {
    title = "Fetched web page";
    badge = "browser";
  } else if (tool === "execute_sandboxed_python") {
    title = "Ran Python script";
    badge = "sandbox";
  } else if (tool === "workspace_read_file" || tool === "file") {
    const p = trace.args?.path || trace.args?.filePath || "";
    const filename = p ? p.split(/[\\/]/).pop() || p : "";
    title = filename ? `Read ${filename}` : "Read file";
    badge = "workspace";
  } else if (tool === "workspace_write_file") {
    const p = trace.args?.path || trace.args?.filePath || "";
    const filename = p ? p.split(/[\\/]/).pop() || p : "";
    title = filename ? `Wrote ${filename}` : "Wrote file";
    badge = "workspace";
  } else if (tool === "workspace_run_command") {
    const cmd = trace.args?.command ? ` (${trace.args.command.slice(0, 24)})` : "";
    title = `Executed command${cmd}`;
    badge = "workspace";
  } else if (tool === "git_commit" || tool.includes("git")) {
    title = "Committed changes to repository";
    badge = "workspace";
  } else if (trace.tier === "workspace" || tool.startsWith("workspace_")) {
    title = tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    badge = "workspace";
  } else if (trace.tier === "browser") {
    title = tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    badge = "browser";
  } else {
    // Humanize snake_case
    title = tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    badge = trace.tier === "sandbox" ? "sandbox" : "sandbox";
  }

  return {
    title,
    duration: durationFormatted,
    badge
  };
}

/**
 * Buffers streaming token fragments until complete sentences/clauses are formed,
 * preventing mid-word text cuts in the UI.
 */
export function bufferSentenceStream(accumulatedText: string): { completedText: string; pendingFragment: string } {
  if (!accumulatedText) return { completedText: "", pendingFragment: "" };

  // Find the last sentence-ending punctuation followed by space or newline
  const match = accumulatedText.match(/^(.*[.!?](?:\s+|\n|$))([\s\S]*)$/);
  if (match) {
    return {
      completedText: match[1].trim(),
      pendingFragment: match[2]
    };
  }

  // If text is long (>140 chars) without terminal punctuation, cut at the last word boundary
  if (accumulatedText.length > 140) {
    const lastSpace = accumulatedText.lastIndexOf(" ");
    if (lastSpace > 60) {
      return {
        completedText: accumulatedText.slice(0, lastSpace).trim(),
        pendingFragment: accumulatedText.slice(lastSpace + 1)
      };
    }
  }

  return {
    completedText: "",
    pendingFragment: accumulatedText
  };
}

export function canonicalizeModelId(modelId?: string | null): string {
  if (!modelId) return "";
  const lower = modelId.trim().toLowerCase().replace(/:latest$/, "");
  if (lower.includes("swift-1.5") || lower.includes("swift-15") || lower === "swift-1.5") {
    return "swift-1.5-qwen3.8-27b-iq3_xs";
  }
  if (lower.includes("flash-next") || lower.includes("gyro-s") || lower.includes("gyro")) {
    return "qwen3.8-flash-next-gyro-gyro-s";
  }
  if (lower.includes("qwen3.8:27b") || lower === "qwen3.8") {
    return "qwen3.8:27b-q3_k_m";
  }
  if (lower.includes("gemma4")) {
    return "gemma4:e4b";
  }
  return lower;
}

export function formatModelDisplayLabel(modelId?: string | null): string {
  const canon = canonicalizeModelId(modelId);
  if (canon === "qwen3.8-flash-next-gyro-gyro-s") return "Flash-Next";
  if (canon === "swift-1.5-qwen3.8-27b-iq3_xs") return "Swift-1.5";
  if (canon === "qwen3.8:27b-q3_k_m") return "qwen3.8";
  if (canon === "gemma4:e4b") return "gemma4:e4b";
  return (modelId || "").trim().replace(/:latest$/, "");
}

export function getServedByNote(modelUsed?: string | null, selectedModel?: string | null): string | null {
  if (!modelUsed || !modelUsed.trim()) return null;
  if (!selectedModel || !selectedModel.trim() || selectedModel.trim().toLowerCase() === "auto") {
    return null;
  }
  const servedCanon = canonicalizeModelId(modelUsed);
  const selectedCanon = canonicalizeModelId(selectedModel);
  if (!servedCanon || !selectedCanon || servedCanon === selectedCanon) {
    return null;
  }
  return "Served by " + formatModelDisplayLabel(modelUsed) + " (" + formatModelDisplayLabel(selectedModel) + " selected)";
}

export interface FormattedChatError {
  summary: string;
  details?: string;
}

/**
 * Normalizes raw chat or engine error payloads into a clean user-facing summary
 * and optional expandable technical details.
 */
export function formatChatErrorMessage(rawError: unknown): FormattedChatError {
  if (!rawError) {
    return { summary: "An unknown error occurred" };
  }

  const rawStr = typeof rawError === "string" ? rawError : (rawError as any).message || String(rawError);
  const trimmed = rawStr.trim();

  // Attempt to find and parse JSON payload within the error string
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const prefix = trimmed.slice(0, jsonMatch.index).trim().replace(/:\s*$/, "");
      let extractedMsg = "";

      if (parsed && typeof parsed === "object") {
        if (typeof parsed.error === "string") {
          extractedMsg = parsed.error;
        } else if (parsed.error && typeof parsed.error.message === "string") {
          extractedMsg = parsed.error.message;
        } else if (typeof parsed.message === "string") {
          extractedMsg = parsed.message;
        }
      }

      if (extractedMsg) {
        const summary = prefix ? `${prefix}: ${extractedMsg}` : extractedMsg;
        return {
          summary,
          details: JSON.stringify(parsed, null, 2)
        };
      }
    } catch {
      // Fall through to plain text handling
    }
  }

  return { summary: trimmed };
}

export interface ChatFileDiffItem {
  id: string;
  path: string;
  tool: string;
  addedLines: number;
  removedLines: number;
  diffPreview: string;
}

/**
 * Extracts diff stats and unified previews from assistant trace objects
 * for file write and patch operations (workspace_write_file, workspace_patch_file, host_write_file).
 */
export function extractFileWriteDiffsFromTraces(traces?: any[]): ChatFileDiffItem[] {
  if (!Array.isArray(traces) || traces.length === 0) {
    return [];
  }

  const items: ChatFileDiffItem[] = [];

  traces.forEach((trace, index) => {
    const tool = trace?.tool || trace?.name;
    if (
      tool !== "workspace_write_file" &&
      tool !== "workspace_patch_file" &&
      tool !== "host_write_file"
    ) {
      return;
    }

    if (trace?.status === "error") {
      return;
    }

    const filePath = trace?.args?.path || trace?.args?.filePath || trace?.args?.targetFile;
    if (!filePath || typeof filePath !== "string") {
      return;
    }

    const id = trace?.id || `${tool}-${filePath}-${index}`;

    if (tool === "workspace_write_file" || tool === "host_write_file") {
      const rawContent = typeof trace?.args?.content === "string" ? trace.args.content : "";
      const normalized = rawContent.replace(/\r\n/g, "\n").replace(/\n$/, "");
      const lines = normalized.length > 0 ? normalized.split("\n") : [];
      const addedLines = lines.length;
      const removedLines = 0;
      let diffPreview = "";
      if (lines.length > 0) {
        const previewLines = lines.slice(0, 40).map((l: string) => "+ " + l);
        diffPreview = previewLines.join("\n");
        if (lines.length > 40) {
          diffPreview += `\n... (${lines.length - 40} more lines)`;
        }
      }

      items.push({
        id,
        path: filePath,
        tool,
        addedLines,
        removedLines,
        diffPreview
      });
    } else if (tool === "workspace_patch_file") {
      const hasOldOrNew =
        trace?.args?.search !== undefined ||
        trace?.args?.oldText !== undefined ||
        trace?.args?.target !== undefined ||
        trace?.args?.replace !== undefined ||
        trace?.args?.newText !== undefined ||
        trace?.args?.replacement !== undefined ||
        trace?.args?.content !== undefined;

      if (!hasOldOrNew && (trace?.args?.diff || trace?.args?.patch)) {
        const diffStr = String(trace.args.diff || trace.args.patch).replace(/\r\n/g, "\n");
        const lines = diffStr.length > 0 ? diffStr.split("\n") : [];
        let addedLines = 0;
        let removedLines = 0;
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
          else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
        }
        let diffPreview = lines.slice(0, 40).join("\n");
        if (lines.length > 40) {
          diffPreview += `\n... (${lines.length - 40} more lines)`;
        }
        items.push({
          id,
          path: filePath,
          tool,
          addedLines,
          removedLines,
          diffPreview
        });
      } else {
        const oldStr = trace?.args?.search ?? trace?.args?.oldText ?? trace?.args?.target ?? "";
        const newStr = trace?.args?.replace ?? trace?.args?.newText ?? trace?.args?.replacement ?? trace?.args?.content ?? "";

        const oldNormalized = oldStr ? String(oldStr).replace(/\r\n/g, "\n").replace(/\n$/, "") : "";
        const newNormalized = newStr ? String(newStr).replace(/\r\n/g, "\n").replace(/\n$/, "") : "";

        const oldLines = oldNormalized.length > 0 ? oldNormalized.split("\n") : [];
        const newLines = newNormalized.length > 0 ? newNormalized.split("\n") : [];

        const removedLines = oldLines.length;
        const addedLines = newLines.length;

        const diffPreview = [
          ...oldLines.slice(0, 20).map((l: string) => "- " + l),
          ...newLines.slice(0, 20).map((l: string) => "+ " + l)
        ].join("\n");

        items.push({
          id,
          path: filePath,
          tool,
          addedLines,
          removedLines,
          diffPreview
        });
      }
    }
  });

  return items;
}

export * from "./chatDiffs";


