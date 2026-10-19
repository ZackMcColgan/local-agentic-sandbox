export interface ModelProfile {
  id: string;
  name: string;
  role: "orchestrator" | "sub-agent" | "verifier";
  recommendedVRAM: string;
  supportsReasoningEffort: boolean;
  defaultReasoningEffort?: "low" | "medium" | "xhigh";
  description: string;
}

export type AgentMode = "auto" | "flash" | "pro";

export interface AgentModeConfig {
  id: AgentMode;
  label: string;
  badgeLabel: string;
  description: string;
  defaultModel: string;
}

export const AGENT_MODES: Record<AgentMode, AgentModeConfig> = {
  auto: {
    id: "auto",
    label: "Auto",
    badgeLabel: "Auto (Hierarchical)",
    description: "Hierarchical routing: Flash (~80 t/s) triage with automated escalation to Pro on deep synthesis or test failures.",
    defaultModel: "Swift-1.5-Qwen3.8-27B-IQ3_XS"
  },
  flash: {
    id: "flash",
    label: "Flash",
    badgeLabel: "Flash ~80 t/s",
    description: "Ultra-fast execution and native multimodal vision via Swift-1.5-Qwen3.8-27B-IQ3_XS.",
    defaultModel: "Swift-1.5-Qwen3.8-27B-IQ3_XS"
  },
  pro: {
    id: "pro",
    label: "Pro",
    badgeLabel: "Pro (27B)",
    description: "Deep reasoning, complete multi-module refactoring, and root-cause analysis via Qwen 3.8 27B / Hermes 3.",
    defaultModel: "Swift-1.5-Qwen3.8-27B-IQ3_XS"
  }
};

export const DEFAULT_AGENT_MODE: AgentMode = "auto";
export const DEFAULT_PRIMARY_MODEL = "Swift-1.5-Qwen3.8-27B-IQ3_XS";
export const DEFAULT_SUBAGENT_MODEL = "Swift-1.5-Qwen3.8-27B-IQ3_XS";

export const PRESET_MODEL_PROFILES: ModelProfile[] = [
  {
    id: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
    name: "Swift 1.5 (27B Qwen 3.8 IQ3_XS)",
    role: "orchestrator",
    recommendedVRAM: "~12.8 GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    description: "Artificial Analysis #1 Open Model with embedded MTP speculative decoding. Deep reasoning, code generation & agentic planning."
  },
  {
    id: "gemma4:e4b",
    name: "Gemma 4 E4B (Flash Multimodal)",
    role: "sub-agent",
    recommendedVRAM: "~4.0 GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "low",
    description: "Ultra-fast natively multimodal model (~80 tok/s). Image/diagram ingestion ready."
  },
  {
    id: "qwen3.8:27b-q3_k_m",
    name: "Qwen 3.8 (27B Q3_K_M Pro)",
    role: "orchestrator",
    recommendedVRAM: "~13.8 GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    description: "Artificial Analysis #1 Open Model. Deep reasoning, code generation & agentic planning."
  },
  {
    id: "hermes3:8b",
    name: "Hermes 3 (8B Llama 3.1)",
    role: "orchestrator",
    recommendedVRAM: "~6.0 GB",
    supportsReasoningEffort: false,
    description: "Nous Research Hermes 3. Purpose-built for unconstrained function calling & multi-turn agentic loops."
  },
  {
    id: "hermes3:70b-q3_k_m",
    name: "Hermes 3 (70B Q3_K_M Pro)",
    role: "orchestrator",
    recommendedVRAM: "~32+ GB",
    supportsReasoningEffort: false,
    description: "Nous Research Hermes 3 70B. Enterprise unconstrained agentic synthesis."
  }
];

export function isReasoningEffortSupported(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  const profile = PRESET_MODEL_PROFILES.find((p) => p.id.toLowerCase() === lower);
  if (profile) return profile.supportsReasoningEffort;
  return lower.includes("qwen") || lower.includes("gemma") || lower.includes("swift");
}

export function getModelProfile(modelId?: string): ModelProfile | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  return PRESET_MODEL_PROFILES.find((p) => p.id.toLowerCase() === lower);
}

