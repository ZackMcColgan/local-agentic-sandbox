import { NextResponse } from "next/server";
import { PRESET_MODEL_PROFILES, DEFAULT_PRIMARY_MODEL } from "@/config/models";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://ollama:11434";
const MCP_BASE = (process.env.MCP_SERVER_URL || "http://mcp-server:8080/sse").replace(/\/sse$/, "");
const ACTIVE_MODEL = process.env.MODEL_NAME || DEFAULT_PRIMARY_MODEL;

export async function GET() {
  const timestamp = new Date().toISOString();

  // 1. Discover Ollama Engine Health and Installed Models
  let ollamaStatus = "OFFLINE";
  let availableModels: string[] = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2500)
    });
    if (res.ok) {
      ollamaStatus = "HEALTHY";
      const data = await res.json();
      availableModels = (data.models || []).map((m: any) => m.name);
    }
  } catch {
    ollamaStatus = "UNREACHABLE";
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

  return NextResponse.json({
    timestamp,
    cluster: {
      network: "ai-mesh",
      air_gapped: true,
      egress_policy: "BLOCKED"
    },
    services: {
      ollama: {
        status: ollamaStatus,
        url: OLLAMA_URL,
        target_model: ACTIVE_MODEL,
        installed_models: availableModels,
        profiles: PRESET_MODEL_PROFILES
      },
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
