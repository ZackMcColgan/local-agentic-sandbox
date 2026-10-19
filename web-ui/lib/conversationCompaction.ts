/**
 * Conversation History Compactor
 *
 * When context window utilization reaches 85% of budget, summarizes older turns
 * while preserving:
 * 1. System prompt (index 0) verbatim
 * 2. Compaction summary of middle turns
 * 3. Most recent 2-3 turns verbatim
 */

import { estimateTokens } from "./contextBudget";

export const DEFAULT_COMPACTION_THRESHOLD = 0.85;
export const DEFAULT_PRESERVE_RECENT_MESSAGES = 4; // ~2 full turns (user + assistant)

export interface CompactionResult {
  compacted: boolean;
  messages: any[];
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Summarizes an array of older messages into a concise structured Markdown digest.
 */
export function summarizeTurnHistory(olderMessages: any[]): string {
  const userQueries: string[] = [];
  const toolsInvoked: Set<string> = new Set();
  const keyDeliverables: string[] = [];

  for (const msg of olderMessages) {
    if (!msg) continue;

    if (msg.role === "user" && typeof msg.content === "string") {
      const trimmed = msg.content.trim().slice(0, 160);
      if (trimmed) userQueries.push(trimmed);
    } else if (msg.role === "tool") {
      if (msg.name) toolsInvoked.add(msg.name);
      if (typeof msg.content === "string" && msg.content.trim()) {
        const clean = msg.content
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/[\r\n\t]+/g, " ")
          .trim();
        if (clean && !clean.startsWith("MCP error") && !clean.startsWith("[Earlier")) {
          const excerpt = clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
          keyDeliverables.push(`Tool ${msg.name || "call"} data: ${excerpt}`);
        }
      }
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name || tc.name;
          if (fnName) toolsInvoked.add(fnName);
        }
      }
      if (typeof msg.content === "string" && msg.content.trim()) {
        const text = msg.content.trim();
        // Capture summary lines or short highlights
        const firstLine = text.split("\n")[0].slice(0, 140);
        if (firstLine && !firstLine.startsWith("<") && !firstLine.startsWith("[Earlier")) {
          keyDeliverables.push(firstLine);
        }
      }
    }
  }

  const lines: string[] = ["[CONVERSATION COMPACTED (85% THRESHOLD)]: Earlier conversation history summarized."];

  if (userQueries.length > 0) {
    lines.push("\nPrior User Goals & Requests:");
    for (const q of userQueries.slice(-4)) {
      lines.push(`- "${q}"`);
    }
  }

  if (toolsInvoked.size > 0) {
    lines.push(`\nTools Utilized: ${Array.from(toolsInvoked).join(", ")}`);
  }

  if (keyDeliverables.length > 0) {
    lines.push("\nKey Insights & Outcomes:");
    for (const d of keyDeliverables.slice(-3)) {
      lines.push(`- ${d}`);
    }
  }

  return lines.join("\n");
}

/**
 * Checks if conversation utilization exceeds 85% of budget, and if so,
 * compacts older turns while preserving system prompt and recent turns.
 */
export function compactConversationHistory(
  messages: any[],
  options?: {
    maxContentTokens?: number;
    compactionThreshold?: number;
    preserveRecentMessages?: number;
  }
): CompactionResult {
  if (!Array.isArray(messages) || messages.length <= 3) {
    const tokens = estimateTokens(messages);
    return { compacted: false, messages, tokensBefore: tokens, tokensAfter: tokens };
  }

  const maxTokens = options?.maxContentTokens ?? 6000;
  const thresholdRatio = options?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const thresholdTokens = Math.floor(maxTokens * thresholdRatio);
  const tokensBefore = estimateTokens(messages);

  if (tokensBefore < thresholdTokens) {
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  const preserveRecent = options?.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
  const hasSystem = messages[0]?.role === "system";
  const startIdx = hasSystem ? 1 : 0;
  const endIdx = Math.max(startIdx, messages.length - preserveRecent);

  if (endIdx <= startIdx) {
    // Not enough intermediate messages to compact
    return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
  }

  const olderMessages = messages.slice(startIdx, endIdx);
  const recentMessages = messages.slice(endIdx);
  const summaryContent = summarizeTurnHistory(olderMessages);

  const compactedMessages: any[] = [];
  if (hasSystem) {
    compactedMessages.push(messages[0]);
  }

  compactedMessages.push({
    role: "assistant",
    content: summaryContent
  });

  compactedMessages.push(...recentMessages);

  const tokensAfter = estimateTokens(compactedMessages);

  return {
    compacted: true,
    messages: compactedMessages,
    tokensBefore,
    tokensAfter
  };
}
