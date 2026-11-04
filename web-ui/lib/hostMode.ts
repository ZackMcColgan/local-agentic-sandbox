/**
 * Host Mode Manager & Client
 *
 * Dispatches host operations via the standalone host runner on the Windows PC
 * (http://127.0.0.1:8765 or http://host.docker.internal:8765).
 * Destructive actions require user approval stored purely in-memory.
 */

export interface HostApprovalRequest {
  id: string;
  threadId: string;
  tool: string;
  args: any;
  riskReason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}

// Strictly in-memory pending approvals. Zero disk persistence, zero host logging.
const pendingApprovals = new Map<string, HostApprovalRequest>();

export function getPendingApprovals(threadId?: string): HostApprovalRequest[] {
  const all = Array.from(pendingApprovals.values());
  if (threadId) {
    return all.filter((a) => a.threadId === threadId && a.status === "pending");
  }
  return all.filter((a) => a.status === "pending");
}

export function createPendingApproval(
  threadId: string,
  tool: string,
  args: any,
  riskReason: string
): HostApprovalRequest {
  const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const approval: HostApprovalRequest = {
    id,
    threadId,
    tool,
    args,
    riskReason,
    status: "pending",
    createdAt: Date.now()
  };
  pendingApprovals.set(id, approval);
  return approval;
}

export function resolvePendingApproval(
  approvalId: string,
  action: "approved" | "rejected"
): HostApprovalRequest | null {
  const req = pendingApprovals.get(approvalId);
  if (!req) return null;
  req.status = action;
  if (action === "rejected") {
    pendingApprovals.delete(approvalId);
  }
  return req;
}

export function isDestructiveHostAction(tool: string, args: any): { isDestructive: boolean; reason?: string } {
  if (tool === "host_delete_path") {
    return {
      isDestructive: true,
      reason: `Permanent deletion of host path: ${args?.path}`
    };
  }

  if (tool === "host_run_powershell") {
    const cmd = String(args?.command || "").toLowerCase();
    const destructivePatterns = [
      /\b(rm|del|erase|remove-item)\b/,
      /\b(format|diskpart|reagentc)\b/,
      /\b(stop-process|taskkill\s+\/f)\b/,
      /\b(drop\s+database|truncate)\b/,
      /\b(reg\s+delete|set-service)\b/,
      /\b(git\s+clean\s+-f|git\s+reset\s+--hard)\b/
    ];

    for (const pattern of destructivePatterns) {
      if (pattern.test(cmd)) {
        return {
          isDestructive: true,
          reason: `High-risk PowerShell command matched: ${pattern.source}`
        };
      }
    }
  }

  return { isDestructive: false };
}

export function getHostRunnerBaseUrl(): string {
  return process.env.HOST_RUNNER_URL || "http://127.0.0.1:8765";
}

export const HOST_RUNNER_BASE_URL = process.env.HOST_RUNNER_URL || "http://127.0.0.1:8765";

export async function checkHostRunnerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getHostRunnerBaseUrl()}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) {
      return false;
    }
    const data = await res.json();
    return data?.status === "ok";
  } catch {
    return false;
  }
}

export async function executeHostTool(tool: string, args: any): Promise<any> {
  const secret = process.env.HOST_RUNNER_SHARED_SECRET || "";
  let timeoutMs = 30000;
  if (tool === "host_run_powershell") {
    let timeoutSec = 120;
    if (typeof args?.timeoutSeconds === "number" && !isNaN(args.timeoutSeconds)) {
      timeoutSec = Math.max(1, Math.min(600, Math.floor(args.timeoutSeconds)));
    }
    timeoutMs = (timeoutSec + 5) * 1000;
  }

  const res = await fetch(`${getHostRunnerBaseUrl()}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Host-Runner-Secret": secret
    },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    throw new Error(`Host runner returned HTTP ${res.status}`);
  }

  return await res.json();
}

export const HOST_TOOLS_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "host_run_powershell",
      description: "Execute a PowerShell command on the host Windows machine. Destructive commands require approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The PowerShell command line to execute." },
          cwd: { type: "string", description: "Optional working directory on the host machine." },
          timeoutSeconds: { type: "number", description: "Optional execution timeout in seconds (1 to 600, default 120)." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_read_file",
      description: "Read the full contents of a file on the host machine filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path on the host machine." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_write_file",
      description: "Write content to a file on the host machine filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path on the host machine." },
          content: { type: "string", description: "Text content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_list_dir",
      description: "List directory contents on the host machine filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path on the host machine." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "host_delete_path",
      description: "Delete a file or directory on the host machine filesystem. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to remove." },
          recursive: { type: "boolean", description: "Whether to recursively delete directories." }
        },
        required: ["path"]
      }
    }
  }
];
