/**
 * Conversation History Compactor
 *
 * When context window utilization reaches 85% of budget, summarizes older turns
 * while preserving:
 * 1. System prompt (index 0) verbatim
 * 2. Compaction summary of middle turns
 * 3. Most recent 2-3 turns verbatim
 */

import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "./contextBudget";

export const DEFAULT_COMPACTION_THRESHOLD = 0.85;
export const DEFAULT_PRESERVE_RECENT_MESSAGES = 4; // ~2 full turns (user + assistant)

export interface CompactionResult {
  compacted: boolean;
  messages: any[];
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Extracts exact file paths, git SHAs, URLs, and error lines verbatim.
 */
export function extractIdentifiersAndErrors(messages: any[]): {
  filePaths: string[];
  gitShas: string[];
  urls: string[];
  errorLines: string[];
} {
  const filePathsSet = new Set<string>();
  const gitShasSet = new Set<string>();
  const urlsSet = new Set<string>();
  const errorLines: string[] = [];

  const filePathRegex = /(?:^|[\s"'(\`])((?:[a-zA-Z]:[\\/]|\/|\.\.?\/|[a-zA-Z0-9_-]+\/)[a-zA-Z0-9_.\-\/\\]+\.[a-zA-Z0-9]{1,12})(?=$|[\s"'\)\`,;:])/gm;
  const gitShaRegex = /\b([0-9a-f]{7,40})\b/gi;
  const urlRegex = /\b(https?:\/\/[^\s<>"'\)]+)/gi;

  for (const msg of messages) {
    if (!msg) continue;

    // Check structured tool calls
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const args = tc.function?.arguments || tc.arguments;
        const argStr = typeof args === "string" ? args : JSON.stringify(args || {});
        for (const m of argStr.matchAll(filePathRegex)) {
          filePathsSet.add(m[1]);
        }
        for (const m of argStr.matchAll(gitShaRegex)) {
          gitShasSet.add(m[1]);
        }
        for (const m of argStr.matchAll(urlRegex)) {
          urlsSet.add(m[1]);
        }
      }
    }

    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    if (!content) continue;

    for (const m of content.matchAll(filePathRegex)) {
      filePathsSet.add(m[1]);
    }
    for (const m of content.matchAll(gitShaRegex)) {
      gitShasSet.add(m[1]);
    }
    for (const m of content.matchAll(urlRegex)) {
      urlsSet.add(m[1]);
    }

    // Extract failure or error lines verbatim (up to 25 lines)
    if (errorLines.length < 25) {
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        const lineExcerpt = trimmed.length > 1000 ? trimmed.slice(0, 1000) : trimmed;
        if (
          trimmed.length > 5 &&
          /\b(error|fail|failed|failure|exception|crash|rejected)\b/i.test(trimmed) &&
          !trimmed.startsWith("<") &&
          !errorLines.includes(lineExcerpt)
        ) {
          errorLines.push(lineExcerpt);
          if (errorLines.length >= 25) break;
        }
      }
    }
  }

  return {
    filePaths: Array.from(filePathsSet),
    gitShas: Array.from(gitShasSet),
    urls: Array.from(urlsSet),
    errorLines
  };
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
      const trimmed = msg.content.trim().slice(0, 2000);
      if (trimmed) userQueries.push(trimmed);
    } else if (msg.role === "tool") {
      if (msg.name) toolsInvoked.add(msg.name);
      if (typeof msg.content === "string" && msg.content.trim()) {
        const clean = msg.content
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/[\r\n\t]+/g, " ")
          .trim();
        if (clean && !clean.startsWith("MCP error") && !clean.startsWith("[Earlier")) {
          const excerpt = clean.length > 300 ? `${clean.slice(0, 297)}...` : clean;
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
        const firstLine = text.split("\n")[0].slice(0, 300);
        if (firstLine && !firstLine.startsWith("<") && !firstLine.startsWith("[Earlier")) {
          keyDeliverables.push(firstLine);
        }
      }
    }
  }

  const { filePaths, gitShas, urls, errorLines } = extractIdentifiersAndErrors(olderMessages);

  const lines: string[] = [
    "[CONVERSATION COMPACTED (85% THRESHOLD)]: Earlier conversation history summarized (85% budget / 85,000 tokens)."
  ];

  if (userQueries.length > 0) {
    lines.push("\nPrior User Goals & Requests:");
    for (const q of userQueries.slice(-8)) {
      lines.push(`- "${q}"`);
    }
  }

  if (toolsInvoked.size > 0) {
    lines.push(`\nTools Utilized: ${Array.from(toolsInvoked).join(", ")}`);
  }

  if (keyDeliverables.length > 0) {
    lines.push("\nKey Insights & Outcomes:");
    for (const d of keyDeliverables.slice(-8)) {
      lines.push(`- ${d}`);
    }
  }

  const maxFilePaths = 100;
  const maxGitShas = 100;
  const maxUrls = 50;
  const maxErrors = 25;

  if (filePaths.length > 0 || gitShas.length > 0 || urls.length > 0) {
    lines.push("\nRetained Identifiers & Artifacts:");
    if (filePaths.length > 0) {
      const displayed = filePaths.slice(0, maxFilePaths).join(", ");
      const overflow = filePaths.length > maxFilePaths ? ` (+${filePaths.length - maxFilePaths} more file paths omitted)` : "";
      lines.push(`- File paths: ${displayed}${overflow}`);
    }
    if (gitShas.length > 0) {
      const displayed = gitShas.slice(0, maxGitShas).join(", ");
      const overflow = gitShas.length > maxGitShas ? ` (+${gitShas.length - maxGitShas} more git SHAs omitted)` : "";
      lines.push(`- Git SHAs: ${displayed}${overflow}`);
    }
    if (urls.length > 0) {
      const displayed = urls.slice(0, maxUrls).join(", ");
      const overflow = urls.length > maxUrls ? ` (+${urls.length - maxUrls} more URLs omitted)` : "";
      lines.push(`- URLs: ${displayed}${overflow}`);
    }
  }

  if (errorLines.length > 0) {
    lines.push("\nCritical Errors & Failures:");
    for (const err of errorLines.slice(0, maxErrors)) {
      lines.push(`- ${err}`);
    }
    if (errorLines.length > maxErrors) {
      lines.push(`- (+${errorLines.length - maxErrors} more error lines omitted)`);
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

  const maxTokens = options?.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS;
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
