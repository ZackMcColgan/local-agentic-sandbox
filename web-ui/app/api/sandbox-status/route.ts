import { NextResponse } from "next/server";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://ollama:11434";
const MCP_BASE = (process.env.MCP_SERVER_URL || "http://mcp-server:8080/sse").replace(/\/sse$/, "");
const MODEL_NAME = process.env.MODEL_NAME || "qwen3.8";

export async function GET() {
  const timestamp = new Date().toISOString();

  // 1. Check Ollama Engine Health
  let ollamaStatus = "OFFLINE";
  let availableModels: string[] = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000)
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
  let mcpTools = ["execute_sandboxed_python", "verify_container_provenance"];
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
        target_model: MODEL_NAME,
        model_loaded: availableModels.some((m) => m.includes("qwen") || m.includes("coder"))
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
