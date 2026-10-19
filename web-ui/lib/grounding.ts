import { isLiveRealTimeIntent } from "./contextBudget";

/**
 * Grounding helpers: validate search queries and decide whether
 * web research actually produced usable evidence.
 */

// Used ONLY by shouldInjectHonestAbort as the abort-path classifier. Do not expand its verb list.
const META_CHALLENGE_RE =
  /^\s*(did|have|are|were|was|do)\s+(you|u)\b[^?]*\b(actually|really|even|truly)?\s*(look(ed)?\s+(it\s+)?up|search(ed)?|check(ed)?|verif(y|ied)|browse[d]?|google[d]?|use[d]?\s+(the\s+)?(web|internet|search)|make\s+(that|this|it)\s+up|hallucinat)/i;

export function isMetaChallenge(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return META_CHALLENGE_RE.test(prompt) || /\b(you\s+made\s+(that|this|it)\s+up|are\s+you\s+sure|is\s+that\s+(real|accurate|true))\b/i.test(prompt);
}

const DENYLIST_PHRASES = [
  // challenge phrasing
  "did you", "have you", "are you", "do you", "were you", "was you",
  // instruction verbs
  "create", "make", "generate", "draw", "build", "render", "produce", "design", "show me", "give me", "write me",
  // format nouns
  "svg", "chart", "graph", "table", "infographic",
  // politeness & conversational meta
  "please", "can you", "could you", "would you", "will you", "where is"
];

function normalizeForValidation(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isValidSearchQuery(query: unknown, userPrompt?: string): boolean {
  if (typeof query !== "string") return false;
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 200) return false;

  const normQuery = normalizeForValidation(trimmed);
  if (!normQuery) return false;

  if (typeof userPrompt === "string" && userPrompt.trim()) {
    const normPrompt = normalizeForValidation(userPrompt);
    if (normQuery === normPrompt && normPrompt.split(" ").length > 4) {
      return false;
    }
  }

  for (const phrase of DENYLIST_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(normQuery)) {
      return false;
    }
  }

  return true;
}

export interface SearchQueryAttemptResult {
  action: "proceed" | "nudge" | "block";
  countAttempt: boolean;
  message?: string;
}

export function evaluateSearchQueryAttempt(
  query: unknown,
  userPrompt?: string,
  nudgesUsed: number = 0
): SearchQueryAttemptResult {
  const isMissing = !query || typeof query !== "string" || !query.trim();

  if (isMissing) {
    if (nudgesUsed < 1) {
      return {
        action: "nudge",
        countAttempt: false,
        message: "You called search_web without a query. Formulate one (information need only) and retry."
      };
    }
    return {
      action: "block",
      countAttempt: true,
      message: "You called search_web without a query after being nudged. Web research blocked."
    };
  }

  if (!isValidSearchQuery(query, userPrompt)) {
    if (nudgesUsed < 1) {
      return {
        action: "nudge",
        countAttempt: false,
        message: "That looks like the user's request, not a search query. Formulate a concise query (information need only) and retry."
      };
    }
    return {
      action: "block",
      countAttempt: true,
      message: "Search query validation failed after being nudged. Web research blocked."
    };
  }

  return {
    action: "proceed",
    countAttempt: false
  };
}

const WEB_TOOLS = new Set(["search_web", "fetch_webpage_markdown"]);
const NO_RESULTS_RE = /\b(no\s+(results|matches|search\s+results)(\s+found)?|0\s+results|nothing\s+found|did\s+not\s+match\s+any)\b/i;
export const SUBSTANTIVE_MIN_CHARS = 200;

function extractText(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(extractText).join("\n");
  if (typeof result === "object") {
    if (Array.isArray(result.content)) return result.content.map((c: any) => (typeof c?.text === "string" ? c.text : extractText(c))).join("\n");
    if (Array.isArray(result.results)) return result.results.map(extractText).join("\n");
    const parts: string[] = [];
    for (const [k, v] of Object.entries(result)) {
      if (k === "error" || k === "isError") continue;
      if (typeof v === "string") parts.push(v);
      else if (v && typeof v === "object") parts.push(extractText(v));
    }
    return parts.join("\n");
  }
  return "";
}

function isErrorResult(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  return Boolean(result.isError || result.error);
}

/** True only if some web trace returned non-error, non-empty, substantive text. */
export function hasSubstantiveWebResults(traces: Array<{ tool: string; result?: any }>): boolean {
  if (!Array.isArray(traces)) return false;
  return traces.some((t) => {
    if (!t || !WEB_TOOLS.has(t.tool)) return false;
    if (isErrorResult(t.result)) return false;
    const text = extractText(t.result).trim();
    if (text.length <= SUBSTANTIVE_MIN_CHARS) return false;
    if (NO_RESULTS_RE.test(text) && text.length < SUBSTANTIVE_MIN_CHARS * 3) return false;
    return true;
  });
}

export const HONEST_ABORT_DIRECTIVE =
  "[GROUNDING FAILURE]: Live data could not be retrieved. Tell the user you could not retrieve it. Do NOT state any temperatures, forecasts, or other live figures.";

export function shouldInjectHonestAbort(input: {
  userPrompt: string;
  priorUserPrompt?: string;
  webResearchCalls: number;
  traces: Array<{ tool: string; result?: any }>;
}): boolean {
  const live =
    isLiveRealTimeIntent(input.userPrompt) ||
    (isMetaChallenge(input.userPrompt) && !!input.priorUserPrompt && isLiveRealTimeIntent(input.priorUserPrompt));
  return live && input.webResearchCalls > 0 && !hasSubstantiveWebResults(input.traces);
}
