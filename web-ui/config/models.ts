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
    defaultModel: "gemma4:e4b"
  },
  flash: {
    id: "flash",
    label: "Flash",
    badgeLabel: "Flash ~80 t/s",
    description: "Ultra-fast execution and multimodal diagram ingestion via Gemma 4 E4B (~80 tok/s).",
    defaultModel: "gemma4:e4b"
  },
  pro: {
    id: "pro",
    label: "Pro",
    badgeLabel: "Pro (27B)",
    description: "Deep reasoning, complete multi-module refactoring, and root-cause analysis via Qwen 3.8 27B / Hermes 3.",
    defaultModel: "qwen3.8:27b-q3_k_m"
  }
};

export const DEFAULT_AGENT_MODE: AgentMode = "auto";
export const DEFAULT_PRIMARY_MODEL = "qwen3.8:27b-q3_k_m";
export const DEFAULT_SUBAGENT_MODEL = "gemma4:e4b";

export const PRESET_MODEL_PROFILES: ModelProfile[] = [
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
