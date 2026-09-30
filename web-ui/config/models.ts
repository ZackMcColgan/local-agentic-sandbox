export interface ModelProfile {
  id: string;
  name: string;
  role: "orchestrator" | "sub-agent" | "verifier";
  recommendedVRAM: string;
  supportsReasoningEffort: boolean;
  defaultReasoningEffort?: "low" | "medium" | "xhigh";
  description: string;
}

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
    description: "Ultra-fast natively multimodal model (~80 tok/s). Image/file input ready."
  },
  {
    id: "qwen3.8:27b-q3_k_m",
    name: "Qwen 3.8 (27B Q3_K_M Pro)",
    role: "orchestrator",
    recommendedVRAM: "~13.8 GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    description: "Artificial Analysis #1 Open Model. Deep reasoning & agentic planning."
  },
  {
    id: "qwen3.8",
    name: "Qwen 3.8 (Default Tag)",
    role: "orchestrator",
    recommendedVRAM: "~16+ GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    description: "Default Qwen 3.8 tag with flexible reasoning control."
  }
];
