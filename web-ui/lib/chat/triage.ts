import { DEFAULT_SUBAGENT_MODEL } from "@/config/models";
import { getLLMProvider } from "@/lib/llm/provider";

export type TriageComplexity = "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS";

export interface TriageDeps {
  chat?: ReturnType<typeof getLLMProvider>["chat"];
  warn?: (...args: unknown[]) => void;
}

export function parseTriageComplexity(rawMessageContent: string | undefined): TriageComplexity {
  const rawContent = (rawMessageContent || "{}")
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(rawContent || "{}");
  if (parsed.complexity === "DEEP_SYNTHESIS") {
    return "DEEP_SYNTHESIS";
  }
  return "SIMPLE_EXECUTION";
}

/**
 * Lean hierarchical triage classifier using fast subagent model (~80 tok/s).
 * Classifies incoming prompt into SIMPLE_EXECUTION vs DEEP_SYNTHESIS in < 300ms.
 */
export async function _triageComplexity(
  userQuery: string,
  llmBaseUrl: string,
  triageModel: string = DEFAULT_SUBAGENT_MODEL,
  deps: TriageDeps = {}
): Promise<TriageComplexity> {
  const chat = deps.chat ?? ((baseUrl, req) => getLLMProvider().chat(baseUrl, req));
  const warn = deps.warn ?? console.warn;
  try {
    const data = await chat(llmBaseUrl, {
      model: triageModel,
      messages: [
        {
          role: "system",
          content: `Classify this user request into COMPLEXITY: 'SIMPLE_EXECUTION' or 'DEEP_SYNTHESIS'.
SIMPLE_EXECUTION: file navigation, git branch operations, running tests/commands, inspecting logs, small bug fixes, direct tool calls.
DEEP_SYNTHESIS: novel system architecture, complex algorithm design, full module refactoring, difficult multi-step planning.
Output JSON strictly: {"complexity": "SIMPLE_EXECUTION" | "DEEP_SYNTHESIS", "reasoning": "brief explanation"}`,
        },
        {
          role: "user",
          content: userQuery,
        },
      ],
      format: "json",
      keep_alive: "24h",
      options: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 128,
      },
    });

    return parseTriageComplexity(data.message?.content);
  } catch (err) {
    warn("[Triage] Error classifying complexity, defaulting to SIMPLE_EXECUTION:", err);
    return "SIMPLE_EXECUTION";
  }
}
