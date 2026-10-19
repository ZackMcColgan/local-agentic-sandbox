import { isLiveRealTimeIntent } from "./contextBudget";

/**
 * Grounding helpers: derive clean web-search queries from user prompts and
 * decide whether web research actually produced usable evidence.
 */

const META_CHALLENGE_RE =
  /^\s*(did|have|are|were|was|do)\s+(you|u)\b[^?]*\b(actually|really|even|truly)?\s*(look(ed)?\s+(it\s+)?up|search(ed)?|check(ed)?|verif(y|ied)|browse[d]?|google[d]?|use[d]?\s+(the\s+)?(web|internet|search)|make\s+(that|this|it)\s+up|hallucinat)/i;

export function isMetaChallenge(prompt: string): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return META_CHALLENGE_RE.test(prompt) || /\b(you\s+made\s+(that|this|it)\s+up|are\s+you\s+sure|is\s+that\s+(real|accurate|true))\b/i.test(prompt);
}

const WRAPPER_PATTERNS: RegExp[] = [
  /^\s*(hey|hi|ok(ay)?|so)[,!\s]+/i,
  /\b(can|could|would|will)\s+(you|u)\s+(please\s+)?/gi,
  /\bplease\b/gi,
  /\b(i\s+(want|need|would\s+like)\s+(you\s+)?(to\s+)?)/gi,
  /\b(did|have|do)\s+(you|u)\s+(actually|really|even|truly)?\s*(look(ed)?\s+(it\s+)?up|search(ed)?(\s+for)?|check(ed)?|verif(y|ied))\b/gi,
  /\b(create|make|draw|generate|build|render|produce|design|give\s+me|show\s+me|write)\b(\s+(me|us))?(\s+(a|an|the|some))?(\s+(nice|simple|quick|small|cool))?(\s+(svg|chart|graph|diagram|image|picture|infographic|visual(ization)?|table|report|summary|html|page|card|widget|plot|map|poster|icon))?(\s+(of|for|about|showing|with|on))?\b/gi,
  /\b(svg|chart|graph|diagram|infographic|visuali[sz]ation|plot)\s+(of|for|about|showing)\b/gi,
  /\b(an?\s+)?(svg|infographic)\b/gi,
  /\b(look\s+up|search\s+(for|the\s+web\s+for)?|find\s+out|tell\s+me|what\s+is|what's|whats)\b/gi
];

function cleanup(s: string): string {
  return s
    .replace(/[?!.]+$/g, "")
    .replace(/^\s*(the|a|an|of|for|about)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,:;-]+|[\s,:;-]+$/g, "")
    .trim();
}

function stripWrappers(prompt: string): string {
  let s = prompt.replace(/\s+/g, " ").trim();
  for (const re of WRAPPER_PATTERNS) s = s.replace(re, " ");
  return cleanup(s);
}

/**
 * Returns the information need from a user prompt, without instruction/format
 * wrappers. If the prompt is a meta-challenge ("did you actually look it up?")
 * and a prior user prompt is supplied, derives from the prior prompt instead.
 */
export function deriveSearchQuery(userPrompt: string, priorUserPrompt?: string): string {
  const raw = typeof userPrompt === "string" ? userPrompt : "";
  const source =
    isMetaChallenge(raw) && priorUserPrompt && priorUserPrompt.trim() && !isMetaChallenge(priorUserPrompt)
      ? priorUserPrompt
      : raw;
  const q = stripWrappers(source);
  if (q.length >= 2) return q.slice(0, 200);
  const fallback = cleanup(source);
  return (fallback || raw.trim() || "news").slice(0, 200);
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
