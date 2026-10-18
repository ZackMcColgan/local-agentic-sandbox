import { NextResponse } from "next/server";
import { PRESET_MODEL_PROFILES, DEFAULT_PRIMARY_MODEL } from "@/config/models";
import { getLLMProvider } from "@/lib/llm/provider";

const LLM_BASE_URL = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || "http://llm-service:11434";
const OLLAMA_URL = LLM_BASE_URL; // backward-compat alias
const MCP_BASE = (process.env.MCP_SERVER_URL || "http://mcp-server:8080/sse").replace(/\/sse$/, "");
const ACTIVE_MODEL = process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;

export async function GET() {
  const timestamp = new Date().toISOString();

  // 1. Discover Inference Engine Health and Installed Models via LLMProvider
  let llmStatus = "OFFLINE";
  let availableModels: string[] = [];
  try {
    const provider = getLLMProvider();
    const isHealthy = await provider.healthCheck(LLM_BASE_URL, { timeoutMs: 2500 });
    if (isHealthy) {
      llmStatus = "HEALTHY";
      availableModels = await provider.listModels(LLM_BASE_URL, { timeoutMs: 2500 });
    }
  } catch {
    llmStatus = "UNREACHABLE";
  }

  // 2. Check MCP Server Health
  let mcpStatus = "OFFLINE";
  const mcpTools = ["execute_sandboxed_python", "verify_container_provenance"];
  try {
    const res = await fetch(`${MCP_BASE}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok) {
      mcpStatus = "HEALTHY";
    }
  } catch {
    mcpStatus = "UNREACHABLE";
  }

  const llmInfo = {
    status: llmStatus,
    url: LLM_BASE_URL,
    target_model: ACTIVE_MODEL,
    installed_models: availableModels,
    profiles: PRESET_MODEL_PROFILES
  };

  return NextResponse.json({
    timestamp,
    cluster: {
      network: "ai-mesh",
      air_gapped: true,
      egress_policy: "BLOCKED"
    },
    services: {
      llm: llmInfo,
      ollama: llmInfo,
      mcp_server: {
        status: mcpStatus,
        url: `${MCP_BASE}/sse`,
        tools: mcpTools
      }
    },
    security_posture: {
      execution_uid: "10001:10001 (unprivileged)",
      root_filesystem: "READ_ONLY",
      capabilities: "CAP_DROP ALL",
      security_opts: ["no-new-privileges:true"],
      tmpfs_buffer: "/tmp (rw,noexec,nosuid,size=64m)",
      provenance_level: "SLSA-3 Verified"
    }
  });
}
