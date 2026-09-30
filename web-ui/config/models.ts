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
export const DEFAULT_SUBAGENT_MODEL = "qwen2.5-coder:7b";

export const PRESET_MODEL_PROFILES: ModelProfile[] = [
  {
    id: "qwen3.8:27b-q3_k_m",
    name: "Qwen 3.8 (27B Q3_K_M)",
    role: "orchestrator",
    recommendedVRAM: "~13.8 GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    description: "Artificial Analysis #1 Open Model. High reasoning & agentic planning."
  },
  {
    id: "qwen3.8",
    name: "Qwen 3.8 (Default Tag)",
    role: "orchestrator",
    recommendedVRAM: "~16+ GB",
    supportsReasoningEffort: true,
    defaultReasoningEffort: "medium",
    description: "Default Qwen 3.8 tag with flexible reasoning control."
  },
  {
    id: "qwen2.5-coder:14b",
    name: "Qwen 2.5 Coder (14B Q4)",
    role: "orchestrator",
    recommendedVRAM: "~9.2 GB",
    supportsReasoningEffort: false,
    description: "Deep coding specialist. Fits comfortably with 7GB free VRAM."
  },
  {
    id: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder (7B Q4)",
    role: "sub-agent",
    recommendedVRAM: "~4.7 GB",
    supportsReasoningEffort: false,
    description: "Ultra-fast execution and coding (~45 tok/s). Recommended for fast chat."
  },
  {
    id: "qwen2.5-coder:1.5b",
    name: "Qwen 2.5 Coder (1.5B)",
    role: "sub-agent",
    recommendedVRAM: "~1.0 GB",
    supportsReasoningEffort: false,
    description: "Instant sub-second response (~185 tok/s). Ultra-lightweight."
  }
];
