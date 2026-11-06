/**
 * Host Mode Manager & Client
 *
 * Dispatches host operations via the standalone host runner on the Windows PC
 * (http://127.0.0.1:8765 or http://host.docker.internal:8765).
 * Destructive actions require user approval stored purely in-memory.
 */

import crypto from "crypto";
import { getBridgeManifest, PROTOCOL_VERSION } from "../../host-bridge/manifest";
import { computeUnifiedFileDiff, TurnFileDiff } from "./chatDiffs";

export interface HostApprovalRequest {
  id: string;
  threadId: string;
  tool: string;
  args: any;
  riskReason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  expiresAt: number;
}

export interface HostContinuationEntry {
  approvalId: string;
  threadId: string;
  tool: string;
  args: any;
  status: "executed" | "rejected" | "expired" | "error";
  result?: any;
  error?: string;
  createdAt: number;
  expiresAt: number; // createdAt + 5 * 60 * 1000 (5 minutes)
}

// Strictly in-memory pending approvals & consumed ID tracking. Zero disk persistence.
const pendingApprovals = new Map<string, HostApprovalRequest>();
const consumedApprovalIds = new Set<string>();

// Strictly in-memory continuation buffer. Zero disk persistence.
const continuationBuffer = new Map<string, HostContinuationEntry>();

export function getPendingApprovals(threadId?: string, now: number = Date.now()): HostApprovalRequest[] {
  // Purge any expired records
  for (const [id, req] of pendingApprovals.entries()) {
    if (req.expiresAt <= now) {
      pendingApprovals.delete(id);
      consumedApprovalIds.add(id);
    }
  }

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
  riskReason: string,
  now: number = Date.now()
): HostApprovalRequest {
  const id = `approval-${crypto.randomUUID()}`;
  const approval: HostApprovalRequest = {
    id,
    threadId,
    tool,
    args,
    riskReason,
    status: "pending",
    createdAt: now,
    expiresAt: now + 10 * 60 * 1000 // 10 minutes
  };
  pendingApprovals.set(id, approval);
  return approval;
}

export type ConsumeApprovalResult =
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "expired"; approval: HostApprovalRequest }
  | { status: "approved" | "rejected"; approval: HostApprovalRequest };

export function consumePendingApproval(
  id: string,
  decision: "approved" | "rejected",
  now: number = Date.now()
): ConsumeApprovalResult {
  if (consumedApprovalIds.has(id)) {
    return { status: "conflict" };
  }

  const entry = pendingApprovals.get(id);
  if (!entry) {
    return { status: "not_found" };
  }

  if (entry.expiresAt <= now) {
    pendingApprovals.delete(id);
    consumedApprovalIds.add(id);
    return { status: "expired", approval: entry };
  }

  pendingApprovals.delete(id);
  consumedApprovalIds.add(id);
  entry.status = decision;
  return { status: decision, approval: entry };
}

export function resolvePendingApproval(
  approvalId: string,
  action: "approved" | "rejected"
): HostApprovalRequest | null {
  const res = consumePendingApproval(approvalId, action);
  if (res.status === "approved" || res.status === "rejected") {
    return res.approval;
  }
  return null;
}

export function recordContinuationEntry(
  entry: Omit<HostContinuationEntry, "createdAt" | "expiresAt">,
  now: number = Date.now()
): HostContinuationEntry {
  const continuation: HostContinuationEntry = {
    ...entry,
    createdAt: now,
    expiresAt: now + 5 * 60 * 1000 // 5 minutes
  };
  continuationBuffer.set(entry.approvalId, continuation);
  return continuation;
}

export function consumeContinuationEntry(
  approvalId: string,
  threadId: string,
  now: number = Date.now()
): { ok: true; entry: HostContinuationEntry } | { ok: false; reason: "not_found" | "expired" | "thread_mismatch" } {
  const entry = continuationBuffer.get(approvalId);
  if (!entry) {
    return { ok: false, reason: "not_found" };
  }

  if (entry.expiresAt <= now) {
    continuationBuffer.delete(approvalId);
    return { ok: false, reason: "expired" };
  }

  if (entry.threadId !== threadId) {
    return { ok: false, reason: "thread_mismatch" };
  }

  continuationBuffer.delete(approvalId);
  return { ok: true, entry };
}

export {
  stripQuotedStrings,
  DESTRUCTIVE_POWERSHELL_PATTERNS,
  isDestructiveHostAction,
  type DestructiveCheckResult
} from "../../host-bridge/classifier";

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

export type HostRunnerState = "DISABLED" | "READY" | "UNAVAILABLE" | "MISMATCH";

export interface HostStatusResponse {
  hostAccess: boolean;
  runnerState: HostRunnerState;
  runnerAvailable: boolean; // boolean backwards compatibility: runnerState === "READY"
  reason?: string;
  expectedSha?: string;
  actualSha?: string;
  protocolVersion?: number;
}

export async function determineHostRunnerState(hostAccess: boolean): Promise<HostStatusResponse> {
  const manifest = getBridgeManifest();
  let probe: any = null;

  try {
    const res = await fetch(`${getHostRunnerBaseUrl()}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      probe = await res.json();
    }
  } catch {}

  if (!hostAccess) {
    return {
      hostAccess: false,
      runnerState: "DISABLED",
      runnerAvailable: false,
      reason: "Host access is disabled for this thread",
      expectedSha: manifest.bridgeSourceSha256,
      actualSha: probe?.bridgeSourceSha256,
      protocolVersion: probe?.protocolVersion
    };
  }

  if (!probe || probe.status !== "ok") {
    return {
      hostAccess: true,
      runnerState: "UNAVAILABLE",
      runnerAvailable: false,
      reason: "Host runner daemon not responding on port 8765",
      expectedSha: manifest.bridgeSourceSha256
    };
  }

  if (
    probe.protocolVersion !== PROTOCOL_VERSION ||
    probe.bridgeSourceSha256 !== manifest.bridgeSourceSha256
  ) {
    return {
      hostAccess: true,
      runnerState: "MISMATCH",
      runnerAvailable: false,
      reason: "Host runner daemon version/digest mismatch. Run AI-ON.ps1 to update.",
      expectedSha: manifest.bridgeSourceSha256,
      actualSha: probe.bridgeSourceSha256,
      protocolVersion: probe.protocolVersion
    };
  }

  return {
    hostAccess: true,
    runnerState: "READY",
    runnerAvailable: true,
    expectedSha: manifest.bridgeSourceSha256,
    actualSha: probe.bridgeSourceSha256,
    protocolVersion: probe.protocolVersion
  };
}

export function shouldAdvertiseHostTools(
  hostAccess: boolean,
  runnerHealthy: boolean | HostRunnerState
): boolean {
  if (hostAccess !== true) return false;
  if (runnerHealthy === true || runnerHealthy === "READY") return true;
  return false;
}

export function getHostStateDirective(state: HostRunnerState, reason?: string): string {
  switch (state) {
    case "DISABLED":
      return (
        "[HOST ACCESS: DISABLED]\n" +
        "Host access is turned off for this thread by user settings. Host tools are disabled.\n" +
        "If the user asks you to inspect, run commands, or interact with their host Windows PC, inform them that host access is currently disabled for this thread and explain that they can enable it via the 'Host' toggle in the chat header."
      );
    case "UNAVAILABLE":
      return (
        `[HOST ACCESS: UNAVAILABLE]\n` +
        `Host access is enabled for this thread, but the host runner daemon is offline or unreachable (${reason || "Host runner daemon not responding on port 8765"}).\n` +
        `Host tools are withheld. You must honestly inform the user that the host daemon is offline and suggest running 'AI-ON.ps1' on their Windows machine to start the runner daemon. You must NEVER pretend to run host commands or fabricate host execution results.`
      );
    case "MISMATCH":
      return (
        `[HOST ACCESS: MISMATCH]\n` +
        `Host access is enabled for this thread, but the host runner daemon has a version or provenance digest mismatch (${reason || "version/digest mismatch"}).\n` +
        `Host tools are withheld for security. You must honestly inform the user that an update is required and suggest running 'AI-ON.ps1' on their Windows machine to rebuild and synchronize the host runner daemon.`
      );
    case "READY":
      return (
        "[HOST ACCESS: READY]\n" +
        "Host access is enabled and the host runner daemon is verified ready.\n" +
        "You have access to host tools (PowerShell execution, file read/write, directory listing, path deletion). Destructive actions (such as file deletion, system modifications, or high-risk commands) require explicit user approval. Always report host execution results honestly and accurately."
      );
  }
}

export function generateHostFileDiff(
  tool: string,
  args: any,
  result: any
): TurnFileDiff | null {
  if (
    (tool === "host_write_file" || tool === "host_replace_string") &&
    result &&
    result.preImageExists &&
    typeof result.preImageContent === "string" &&
    args?.path
  ) {
    let afterContent: string | null = null;
    if (tool === "host_write_file") {
      afterContent = typeof args.content === "string" ? args.content : null;
    } else if (tool === "host_replace_string") {
      if (typeof args.oldString === "string" && typeof args.newString === "string") {
        afterContent = result.preImageContent.replace(args.oldString, args.newString);
      } else if (typeof args.newString === "string") {
        afterContent = args.newString;
      }
    }

    if (afterContent !== null && afterContent !== result.preImageContent) {
      return computeUnifiedFileDiff(args.path, result.preImageContent, afterContent);
    }
  }
  return null;
}

export async function executeHostTool(tool: string, args: any, approvalId?: string): Promise<any> {
  const secret = process.env.HOST_RUNNER_SHARED_SECRET || "";
  let timeoutMs = 30000;
  if (tool === "host_run_powershell") {
    let timeoutSec = 120;
    if (typeof args?.timeoutSeconds === "number" && !isNaN(args.timeoutSeconds)) {
      timeoutSec = Math.max(1, Math.min(600, Math.floor(args.timeoutSeconds)));
    }
    timeoutMs = (timeoutSec + 5) * 1000;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Host-Runner-Secret": secret
  };
  if (approvalId) {
    headers["X-Host-Approval-Id"] = approvalId;
  }

  let res: Response;
  try {
    res = await fetch(`${getHostRunnerBaseUrl()}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err: any) {
    throw new Error(`Host runner daemon disconnected mid-turn: ${err?.message || "connection error"}`);
  }

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
          path: { type: "string", description: "Absolute path on the host machine." },
          start_line: { type: "number", description: "Optional start line (1-indexed)." },
          end_line: { type: "number", description: "Optional end line (1-indexed)." },
          offset: { type: "number", description: "Optional line offset." },
          limit: { type: "number", description: "Optional line count limit." }
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
