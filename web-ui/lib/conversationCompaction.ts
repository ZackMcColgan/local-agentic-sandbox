/**
 * Conversation History Compactor
 *
 * When context window utilization reaches 85% of budget, summarizes older turns
 * while preserving:
 * 1. System prompt (index 0) verbatim
 * 2. Compaction summary of middle turns
 * 3. Most recent 2-3 turns verbatim
 *
 * COMPACTION STRATEGY (owner ruling Nov 10, 2026):
 * - COMPACTION_STRATEGY=extraction (default): the extraction digest only.
 *   Flag OFF reproduces extraction behavior exactly.
 * - COMPACTION_STRATEGY=hybrid: extraction first, unchanged; then, when the
 *   post-extraction model view still exceeds 65% of the 100K budget, ONE
 *   guarded model summarization pass over the extraction digest plus the
 *   messages it replaced. The pass pins temperature 0.2, caps generation at
 *   8192 tokens, enforces a 180s inactivity deadline and a 5-min total
 *   deadline, and must pass a programmatic identifier post-check. ANY
 *   failure, timeout, truncation, or post-check rejection falls back to the
 *   extraction digest. The extraction digest is ALWAYS retained in the thread
 *   record alongside any model summary (audit copy).
 */

import { estimateTokens, CHAT_CONTEXT_BUDGET_TOKENS } from "./contextBudget";

export const DEFAULT_COMPACTION_THRESHOLD = 0.85;
export const DEFAULT_PRESERVE_RECENT_MESSAGES = 4; // ~2 full turns (user + assistant)

export type CompactionStrategy = "extraction" | "hybrid";

/** Post-extraction escalation threshold: hybrid summarization runs only when the
 * extraction-compacted model view still exceeds 65% of the context budget. */
export const HYBRID_ESCALATION_THRESHOLD = 0.65;

/** Guardrails pinned by the owner ruling for the single summarization pass. */
export const SUMMARIZATION_TEMPERATURE = 0.2;
export const SUMMARIZATION_MAX_TOKENS = 8192;
export const SUMMARIZATION_INACTIVITY_MS = 180_000;
export const SUMMARIZATION_TOTAL_DEADLINE_MS = 300_000;

/** Exact header line the live model digest must begin with (rule from COMPACTION_PROMPT_V1). */
export const COMPACTION_MODEL_DIGEST_HEADER =
  "[CONVERSATION COMPACTED (MODEL DIGEST)]: Earlier conversation history summarized. Extraction digest retained in the thread record as audit copy.";

/**
 * COMPACTION_PROMPT_V1 — shipped VERBATIM per owner ruling (Nov 10, 2026).
 * Do not rewrite, retune, or improve. Objections go to docs/queue-steer-runlog.md.
 */
export const COMPACTION_PROMPT_V1 = `You are compacting the working memory of an ongoing conversation so it can continue past its context limit. Your output REPLACES the conversation history that follows. The assistant continuing this conversation will rely on your output as its only memory of that history. Write for that reader: complete on what matters, ruthless on what does not.

RULES — inviolable, in priority order:
1. NEVER INVENT. Every fact in your output comes from the source. If you are unsure whether something mattered, keep it. If you are unsure of a value, copy it exactly — never guess, round, or repair it.
2. IDENTIFIERS VERBATIM. File paths, SHAs, URLs, tokens, ports, IDs, names, version numbers, and numeric values are copied character-for-character.
3. CORRECTIONS WIN. If a fact was later corrected or replaced, output only the current value, noted as "(supersedes: <old value>)". A superseded value is never presented as current.
4. CONSTRAINTS IN FULL. Every instruction, requirement, prohibition, or preference the user stated is preserved completely, wherever it appeared — the beginning, middle, or end of their message. Do not paraphrase these.
5. DECISIONS KEEP THEIR REASONS. For every decision: what was decided, who decided it (user or assistant), and why, if a reason was given.
6. OPEN THREADS STAY OPEN. Unresolved questions, unfinished tasks, promised actions, and anything awaiting the user are listed as open. Never resolve an open thread by implication.
7. ERRORS VERBATIM. Failure and error lines are copied exactly.
8. COMPRESS REPETITION. Repeated or near-identical content becomes a single line noting what repeated and approximately how much of it there was. Greetings, acknowledgments, and process chatter are dropped.
9. ORDER. Within each section, preserve chronological order wherever sequence matters (decisions, corrections, errors).

OUTPUT — exactly these sections, in this order, as markdown. No preamble, no closing remarks, no commentary about the task. Omit a section only if it would be empty. Begin with the header line exactly as written:

[CONVERSATION COMPACTED (MODEL DIGEST)]: Earlier conversation history summarized. Extraction digest retained in the thread record as audit copy.

Prior User Goals & Requests:
- <each distinct user goal or request, in order>

Key Decisions & Rationale:
- <decision> — decided by <user|assistant> — <reason, if given>

User Constraints & Preferences:
- <each constraint carried in full, per rule 4>

Key Insights & Outcomes:
- <what was established, built, verified, or answered>

Open Threads:
- <each open item, marked with what it is waiting on>

Retained Identifiers & Artifacts:
- File paths: <verbatim list>
- Git SHAs: <verbatim list>
- URLs: <verbatim list>
- Other identifiers: <tokens, ports, IDs, verbatim>

Critical Errors & Failures:
- <error lines verbatim>

LENGTH: your output must be substantially shorter than the source. Cut narrative prose first; the protected categories above are never cut for length. Target under 4,000 tokens — if protected material alone exceeds the target, protected material wins.`;

/**
 * Resolves the compaction strategy from COMPACTION_STRATEGY.
 * Default (unset or unrecognized) is "extraction" — flag OFF reproduces
 * extraction behavior exactly.
 */
export function resolveCompactionStrategy(env?: Record<string, string | undefined>): CompactionStrategy {
  const raw = (env?.COMPACTION_STRATEGY ?? process.env.COMPACTION_STRATEGY ?? "").trim().toLowerCase();
  return raw === "hybrid" ? "hybrid" : "extraction";
}

export interface CompactionResult {
  compacted: boolean;
  messages: any[];
  tokensBefore: number;
  tokensAfter: number;
}

export type HybridFallbackReason =
  | "generation_failure"
  | "timeout"
  | "truncated"
  | "empty_summary"
  | "identifier_post_check_rejected";

export interface SummarizeRequest {
  /** The extraction digest produced from the replaced messages. */
  digest: string;
  /** The messages the digest replaced (source material for the model pass). */
  replacedMessages: any[];
  /** COMPACTION_PROMPT_V1, verbatim. */
  prompt: string;
  temperature: number;
  maxTokens: number;
  inactivityMs: number;
  totalDeadlineMs: number;
  /** Aborted when the inactivity or total deadline elapses. */
  signal: AbortSignal;
}

export interface SummarizeResult {
  text: string;
  /** Set true when generation hit the token cap (finish_reason === "length"). */
  truncated?: boolean;
}

export interface IdentifierCoverageResult {
  ok: boolean;
  missing: string[];
}

/**
 * Programmatic identifier post-check (not a prompt hope): every file path,
 * git SHA, and URL present in the extraction digest must appear verbatim in
 * the model summary. A summary failing the check is rejected.
 */
export function verifyIdentifierCoverage(digest: string, summary: string): IdentifierCoverageResult {
  const extracted = extractIdentifiersAndErrors([
    { role: "assistant", content: digest }
  ]);
  const missing: string[] = [];
  for (const id of [...extracted.filePaths, ...extracted.gitShas, ...extracted.urls]) {
    if (!summary.includes(id)) {
      missing.push(id);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Wraps a summarization callback with the pinned inactivity (180s) and total
 * (5-min) deadlines. Rejects with Error("timeout") when either fires.
 */
async function runSummarizationWithinDeadlines(req: SummarizeRequest, summarize: (req: SummarizeRequest) => Promise<SummarizeResult | string>): Promise<SummarizeResult> {
  const controller = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => controller.abort("inactivity"), SUMMARIZATION_INACTIVITY_MS);
  };
  resetInactivity();
  const totalTimer = setTimeout(() => controller.abort("total"), SUMMARIZATION_TOTAL_DEADLINE_MS);

  // Any chunk-producing callback may call signal-notifying progress via req.signal;
  // the deadline aborts below regardless.
  try {
    const result = await Promise.race([
      summarize(req),
      new Promise<never>((_, reject) => {
        req.signal.addEventListener("abort", () => {
          reject(new Error("timeout"));
        });
        if (req.signal.aborted) reject(new Error("timeout"));
      })
    ]);
    return typeof result === "string" ? { text: result } : result;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    clearTimeout(totalTimer);
  }
}

export interface HybridCompactionResult extends CompactionResult {
  strategy: CompactionStrategy;
  /** The extraction digest — always retained, audit copy. */
  extractionDigest?: string;
  /** Content placed into the live model view (model digest or extraction digest). */
  liveContent?: string;
  modelSummaryUsed: boolean;
  fallback: boolean;
  fallbackReason?: HybridFallbackReason;
  /** Messages replaced by the digest (for the summarization source). */
  replacedMessages?: any[];
}

/**
 * Extraction-first compaction with optional guarded hybrid escalation.
 *
 * - strategy extraction (flag OFF): identical to compactConversationHistory.
 * - strategy hybrid: after extraction, if the compacted model view still
 *   exceeds HYBRID_ESCALATION_THRESHOLD (65%) of the budget, run exactly ONE
 *   summarization pass over the extraction digest + replaced messages under
 *   COMPACTION_PROMPT_V1 with pinned guardrails. The summary must begin with
 *   COMPACTION_MODEL_DIGEST_HEADER and pass verifyIdentifierCoverage; any
 *   failure/timeout/truncation/rejection falls back to the extraction digest.
 */
export async function runHybridCompaction(
  messages: any[],
  options: {
    maxContentTokens?: number;
    compactionThreshold?: number;
    preserveRecentMessages?: number;
    strategy?: CompactionStrategy;
    summarize: (req: SummarizeRequest) => Promise<SummarizeResult | string>;
  }
): Promise<HybridCompactionResult> {
  const strategy = options.strategy ?? resolveCompactionStrategy();
  const base = compactConversationHistory(messages, {
    maxContentTokens: options.maxContentTokens,
    compactionThreshold: options.compactionThreshold,
    preserveRecentMessages: options.preserveRecentMessages
  });

  const digestIndex = base.messages[0]?.role === "system" ? 1 : 0;

  if (strategy === "extraction") {
    return {
      ...base,
      strategy: "extraction",
      extractionDigest: base.compacted ? base.messages[digestIndex]?.content : undefined,
      liveContent: base.compacted ? base.messages[digestIndex]?.content : undefined,
      modelSummaryUsed: false,
      fallback: false
    };
  }

  if (!base.compacted) {
    return {
      ...base,
      strategy: "hybrid",
      modelSummaryUsed: false,
      fallback: false
    };
  }

  const maxTokens = options.maxContentTokens ?? CHAT_CONTEXT_BUDGET_TOKENS;
  const postExtractionRatio = base.tokensAfter / maxTokens;
  if (postExtractionRatio <= HYBRID_ESCALATION_THRESHOLD) {
    return {
      ...base,
      strategy: "hybrid",
      extractionDigest: base.messages[digestIndex]?.content,
      liveContent: base.messages[digestIndex]?.content,
      modelSummaryUsed: false,
      fallback: false
    };
  }

  const digest = base.messages[digestIndex]?.content ?? "";
  const replacedMessages = base.replacedMessages ?? [];

  const controller = new AbortController();
  const req: SummarizeRequest = {
    digest,
    replacedMessages,
    prompt: COMPACTION_PROMPT_V1,
    temperature: SUMMARIZATION_TEMPERATURE,
    maxTokens: SUMMARIZATION_MAX_TOKENS,
    inactivityMs: SUMMARIZATION_INACTIVITY_MS,
    totalDeadlineMs: SUMMARIZATION_TOTAL_DEADLINE_MS,
    signal: controller.signal
  };

  const fallbackToDigest = (reason: HybridFallbackReason): HybridCompactionResult => ({
    ...base,
    strategy: "hybrid",
    extractionDigest: digest,
    liveContent: digest,
    modelSummaryUsed: false,
    fallback: true,
    fallbackReason: reason,
    replacedMessages
  });

  let result: SummarizeResult;
  try {
    result = await runSummarizationWithinDeadlines(req, options.summarize);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    return fallbackToDigest(msg.includes("timeout") || msg.includes("deadline") || msg.includes("abort") ? "timeout" : "generation_failure");
  }

  if (!result.text.trim()) {
    return fallbackToDigest("empty_summary");
  }
  if (result.truncated) {
    return fallbackToDigest("truncated");
  }
  if (!result.text.startsWith(COMPACTION_MODEL_DIGEST_HEADER)) {
    return fallbackToDigest("identifier_post_check_rejected");
  }
  const coverage = verifyIdentifierCoverage(digest, result.text);
  if (!coverage.ok) {
    return fallbackToDigest("identifier_post_check_rejected");
  }

  const hybridMessages: any[] = [...base.messages];
  hybridMessages[digestIndex] = { role: "assistant", content: result.text };
  const tokensAfter = estimateTokens(hybridMessages);

  return {
    compacted: true,
    messages: hybridMessages,
    tokensBefore: base.tokensBefore,
    tokensAfter,
    strategy: "hybrid",
    extractionDigest: digest,
    liveContent: result.text,
    modelSummaryUsed: true,
    fallback: false,
    replacedMessages
  };
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

  const filePathRegex = /(?:^|[\s"(\`])((?:[a-zA-Z]:[\\/]|\/|\.\.?\/|[a-zA-Z0-9_-]+\/)[a-zA-Z0-9_.\-\/\\]+\.[a-zA-Z0-9]{1,12})(?=$|[\s"'\)`,;:])/gm;
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
): CompactionResult & { replacedMessages?: any[] } {
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
    tokensAfter,
    replacedMessages: olderMessages
  };
}