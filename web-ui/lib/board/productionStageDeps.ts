import { NextRequest } from "next/server";
import { executeHostTool as defaultExecuteHostTool } from "../hostMode";
import { ThreadStore, type Thread } from "../threads/threadStore";
import { prepareSelfDeployPlan } from "../selfDeployMachinery";
import type { BoardOrchestratorDeps } from "./boardOrchestrator";
import type { DispatcherBoardItem } from "./dispatcher";
import type { FlowMonitorBoardItem, PrCheckResult, PrChecksSnapshot } from "./flowMonitor";
import type { GateVerdict, MechanicalCheckInput, ReviewerVerdict } from "./reviewerGate";
import type {
  BankRollbackResult,
  BuildImportResult,
  CurrentStateSnapshot,
  SelfDeployVerifiedDeps,
  VerifyDeploymentResult,
} from "../deploy/selfDeployVerified";
import { waitForTurnSettled } from "../chat/turnEngine";
import { readResponseStreamTail } from "./streamTail";

export const DEFAULT_REVIEWER_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REVIEWER_POLL_INTERVAL_MS = 2_000;

export interface HostBridgeCommandResult {
  ok?: boolean;
  success?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type HeadShaResolutionResult = { ok: true; headSha: string } | { ok: false; reason: string };

export type HostBridgeExecutor = (
  tool: string,
  args: Record<string, unknown>
) => Promise<HostBridgeCommandResult>;

export interface StageThreadStore {
  createThread: (input: { title?: string; initialPrompt?: string; boardItemId?: string }) => Thread;
  getThread: (id: string) => Promise<Thread | null> | Thread | null;
}

export interface ReviewerChatDispatchResult {
  ok: boolean;
  status: number;
  /** Bounded tail of the chat response stream (at most `STREAM_TAIL_CAP_BYTES`), not the full stream. */
  rawStream?: string;
  /** Total bytes consumed from the response stream before tail truncation. */
  streamTotalBytes?: number;
}

export type ReviewerChatDispatcher = (params: {
  threadId: string;
  brief: string;
}) => Promise<ReviewerChatDispatchResult>;

export interface ProductionStageDepsOptions {
  executeHostTool?: HostBridgeExecutor;
  threadStore?: StageThreadStore;
  dispatchChatTurn?: ReviewerChatDispatcher;
  hostCheckoutPath?: string;
  reviewerTimeoutMs?: number;
  reviewerPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ProductionStageDeps {
  flowMonitor: NonNullable<BoardOrchestratorDeps["flowMonitor"]>;
  reviewerGate: NonNullable<BoardOrchestratorDeps["reviewerGate"]>;
  resolveHeadSha: NonNullable<BoardOrchestratorDeps["resolveHeadSha"]>;
  resolveHeadShaDetailed: (prNumber: number) => Promise<HeadShaResolutionResult>;
  selfDeploy: {
    deps: SelfDeployVerifiedDeps;
  };
}

interface GhPrCheckRow {
  name?: unknown;
  state?: unknown;
  bucket?: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultDispatchChatTurn(params: {
  threadId: string;
  brief: string;
}): Promise<ReviewerChatDispatchResult> {
  const { POST: chatPost } = await import("../../app/api/chat/route");
  const chatReq = new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-consumer": "in-process",
      "x-dispatch-source": "board-reviewer",
    },
    body: JSON.stringify({
      threadId: params.threadId,
      messages: [{ role: "user", content: params.brief }],
    }),
  });
  const response = await chatPost(chatReq);
  let rawStream = "";
  let streamTotalBytes = 0;
  try {
    const tailResult = await readResponseStreamTail(response);
    rawStream = tailResult.tail;
    streamTotalBytes = tailResult.totalBytes;
  } catch {
    // Await the turn's own settlement rather than failing on stream backpressure.
  }
  await waitForTurnSettled(params.threadId);
  return { ok: response.ok, status: response.status, rawStream, streamTotalBytes };
}

function isCommandSuccess(res: HostBridgeCommandResult | null | undefined): boolean {
  if (!res) return false;
  if (res.ok === false || res.success === false) return false;
  if (typeof res.exitCode === "number" && res.exitCode !== 0) return false;
  return true;
}

export function describeBridgeFailure(
  commandLabel: string,
  res: HostBridgeCommandResult | null | undefined
): string {
  if (!res) {
    return `${commandLabel} failed: empty bridge response`;
  }
  const parts: string[] = [];
  if (typeof res.exitCode === "number" && res.exitCode !== 0) {
    parts.push(`exit ${res.exitCode}`);
  }
  const detail = [res.error, res.stderr]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .join("; ");
  if (detail) {
    return parts.length > 0
      ? `${commandLabel} failed (${parts.join(", ")}): ${detail}`
      : `${commandLabel} failed: ${detail}`;
  }
  if (parts.length > 0) {
    return `${commandLabel} failed (${parts.join(", ")})`;
  }
  if (res.ok === false || res.success === false) {
    return `${commandLabel} failed: bridge reported unsuccessful result without stderr or error text`;
  }
  if (typeof res.stdout !== "string") {
    return `${commandLabel} failed: bridge returned non-string stdout`;
  }
  return `${commandLabel} failed: unknown bridge error`;
}

export function parseHeadRefOid(commandLabel: string, stdout: string): HeadShaResolutionResult {
  let parsedHead: unknown;
  try {
    parsedHead = JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `${commandLabel} returned invalid JSON: ${msg}`,
    };
  }
  const rawHeadSha =
    parsedHead && typeof parsedHead === "object" && !Array.isArray(parsedHead)
      ? (parsedHead as { headRefOid?: unknown }).headRefOid
      : undefined;
  const headSha = typeof rawHeadSha === "string" ? rawHeadSha.trim() : "";
  if (headSha.length === 0) {
    return {
      ok: false,
      reason: `${commandLabel} returned JSON without a non-empty headRefOid`,
    };
  }
  return { ok: true, headSha };
}

function mapGhCheckRow(row: GhPrCheckRow): PrCheckResult | null {
  if (typeof row?.name !== "string" || !row.name.trim()) {
    return null;
  }
  const name = row.name.trim();
  const state = typeof row.state === "string" ? row.state.trim().toUpperCase() : "";
  const bucket = typeof row.bucket === "string" ? row.bucket.trim().toLowerCase() : "";

  if (bucket === "pass" || state === "SUCCESS") {
    return { name, status: "COMPLETED", conclusion: "SUCCESS" };
  }
  if (bucket === "cancel" || state === "CANCELLED") {
    return { name, status: "COMPLETED", conclusion: "CANCELLED" };
  }
  if (
    bucket === "fail" ||
    state === "FAILURE" ||
    state === "ERROR" ||
    state === "STARTUP_FAILURE" ||
    state === "TIMED_OUT" ||
    state === "ACTION_REQUIRED"
  ) {
    const conclusion = state === "TIMED_OUT" || state === "ACTION_REQUIRED" ? state : "FAILURE";
    return { name, status: "COMPLETED", conclusion };
  }
  if (bucket === "skipping" || state === "SKIPPED" || state === "NEUTRAL") {
    return { name, status: "COMPLETED", conclusion: state || "SKIPPED" };
  }

  return { name, status: "IN_PROGRESS", conclusion: null };
}

function extractItemAllowlist(item: DispatcherBoardItem): string[] {
  const candidate = (item as DispatcherBoardItem & { allowlist?: unknown }).allowlist;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
  );
}

/**
 * Verdict-line grammar accepted from the reviewer model. The model emits its
 * verdict as a markdown heading ("## Verdict: **PASS**"), so markdown
 * decoration (leading heading markers # through ######, bold/italic markers)
 * is stripped before matching. That tolerates every combination of heading +
 * bold label + bold token plus the plain forms ("Verdict: PASS", bare "PASS").
 * Genuinely unparseable output stays fail-closed.
 */
const REVIEWER_VERDICT_LINE = /^(?:verdict\s*[:=]?\s*)?(PASS|FAIL)\b[.!?]*$/i;

function normalizeReviewerVerdictLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*/g, "")
    .trim();
}

export function parseReviewerVerdictContent(threadId: string, content: string): ReviewerVerdict {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let parsedVerdict: GateVerdict | null = null;
  const evidence: string[] = [];

  for (const line of lines) {
    const explicitMatch = REVIEWER_VERDICT_LINE.exec(normalizeReviewerVerdictLine(line));
    if (explicitMatch && parsedVerdict === null) {
      const normalized = explicitMatch[1].toUpperCase();
      if (normalized === "PASS" || normalized === "FAIL") {
        parsedVerdict = normalized;
        continue;
      }
    }
    evidence.push(line);
  }

  if (!parsedVerdict) {
    return {
      threadId,
      verdict: "FAIL",
      evidence: [
        `Reviewer thread ${threadId} produced an unparseable verdict.`,
        ...(lines.length > 0 ? [`Raw output: ${lines.slice(0, 3).join(" | ")}`] : []),
      ],
    };
  }

  return {
    threadId,
    verdict: parsedVerdict,
    evidence: evidence.length > 0 ? evidence : [`Reviewer returned ${parsedVerdict}.`],
  };
}

function formatImageRef(tag: string): string {
  const trimmed = tag.trim();
  if (trimmed.includes(":")) {
    return trimmed;
  }
  return `local-agentic-sandbox-web-ui:${trimmed}`;
}

function extractPodMetrics(rawJson: string): {
  podStatus: string;
  podRestarts: number;
  observedImage: string;
} {
  try {
    const parsed = JSON.parse(rawJson) as {
      items?: Array<{
        status?: {
          phase?: string;
          containerStatuses?: Array<{ restartCount?: number; image?: string }>;
        };
      }>;
    };
    const firstPod = parsed.items?.[0];
    const phase = firstPod?.status?.phase ?? "Unknown";
    const containers = firstPod?.status?.containerStatuses ?? [];
    const restarts = containers.reduce(
      (sum, c) => sum + (typeof c.restartCount === "number" ? c.restartCount : 0),
      0
    );
    const observedImage = containers[0]?.image ?? "";
    return { podStatus: phase, podRestarts: restarts, observedImage };
  } catch {
    return { podStatus: "Unknown", podRestarts: -1, observedImage: "" };
  }
}

export function createProductionStageDeps(
  options: ProductionStageDepsOptions = {}
): ProductionStageDeps {
  const execBridge: HostBridgeExecutor =
    options.executeHostTool ?? ((tool, args) => defaultExecuteHostTool(tool, args));
  const threadStore: StageThreadStore = options.threadStore ?? new ThreadStore();
  const dispatchChatTurn: ReviewerChatDispatcher =
    options.dispatchChatTurn ?? defaultDispatchChatTurn;
  const hostCheckoutPath = options.hostCheckoutPath ?? process.env.HOST_CHECKOUT_PATH;
  const reviewerTimeoutMs = options.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
  const reviewerPollIntervalMs =
    options.reviewerPollIntervalMs ?? DEFAULT_REVIEWER_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((msg: string) => console.info(msg));

  async function runHostCommand(
    command: string,
    timeoutSeconds: number = 120
  ): Promise<HostBridgeCommandResult> {
    const args: Record<string, unknown> = { command, timeoutSeconds };
    if (hostCheckoutPath) {
      args.cwd = hostCheckoutPath;
    }
    return execBridge("host_run_powershell", args);
  }

  /**
   * Resolve the real head SHA for a PR via `gh pr view --json headRefOid`.
   * Returns a structured result with the specific failure reason on any error
   * and logs every failure via the stage log channel.
   */
  async function resolvePrHeadShaDetailed(prNumber: number): Promise<HeadShaResolutionResult> {
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
      const reason = `Invalid PR number for head SHA resolution: ${String(prNumber)}`;
      log(`[production-stage-deps] ${reason}`);
      return { ok: false, reason };
    }
    const command = `gh pr view ${prNumber} --json headRefOid`;
    try {
      const headRes = await runHostCommand(command, 60);
      if (!isCommandSuccess(headRes) || typeof headRes.stdout !== "string") {
        const reason = describeBridgeFailure(command, headRes);
        log(`[production-stage-deps] ${reason}`);
        return { ok: false, reason };
      }
      const parsed = parseHeadRefOid(command, headRes.stdout);
      if (!parsed.ok) {
        log(`[production-stage-deps] ${parsed.reason}`);
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = `${command} threw: ${msg}`;
      log(`[production-stage-deps] ${reason}`);
      return { ok: false, reason };
    }
  }

  async function resolvePrHeadSha(prNumber: number): Promise<string | null> {
    const res = await resolvePrHeadShaDetailed(prNumber);
    return res.ok ? res.headSha : null;
  }

  const flowMonitor: NonNullable<BoardOrchestratorDeps["flowMonitor"]> = {
    async pollChecks(item: FlowMonitorBoardItem): Promise<PrChecksSnapshot> {
      const prNumber = item.prNumber;
      const fallbackHeadSha = "unknown";
      if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
        return { headSha: fallbackHeadSha, checks: [] };
      }

      try {
        const [checksRes, headSha] = await Promise.all([
          runHostCommand(`gh pr checks ${prNumber} --json name,state,bucket`, 60),
          resolvePrHeadSha(prNumber),
        ]);
        if (!isCommandSuccess(checksRes) || typeof checksRes.stdout !== "string") {
          return { headSha: fallbackHeadSha, checks: [] };
        }
        if (!headSha) {
          return { headSha: fallbackHeadSha, checks: [] };
        }
        const parsed: unknown = JSON.parse(checksRes.stdout);
        if (!Array.isArray(parsed)) {
          return { headSha: fallbackHeadSha, checks: [] };
        }
        const checks = parsed
          .map((row) => mapGhCheckRow(row as GhPrCheckRow))
          .filter((entry): entry is PrCheckResult => entry !== null);
        return { headSha, checks };
      } catch {
        return { headSha: fallbackHeadSha, checks: [] };
      }
    },

    async issueThread({ item, brief }) {
      const thread = threadStore.createThread({
        title: `Fix cycle: ${item.key} ${item.title}`,
        initialPrompt: brief,
      });
      return { threadId: thread.id };
    },
  };

  const reviewerGate: NonNullable<BoardOrchestratorDeps["reviewerGate"]> = {
    async getMechanicalInput(
      item: DispatcherBoardItem,
      pr: { prNumber: number; headSha: string }
    ): Promise<MechanicalCheckInput> {
      const prNum = pr.prNumber;
      const diffCmd = `gh pr diff ${prNum}`;
      const commitsCmd = `gh pr view ${prNum} --json commits`;
      const branchCmd = `gh pr view ${prNum} --json headRefName`;

      const runSafe = async (command: string): Promise<HostBridgeCommandResult> => {
        try {
          return await runHostCommand(command, 60);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, success: false, error: msg };
        }
      };

      const [diffRes, commitsRes, branchRes] = await Promise.all([
        runSafe(diffCmd),
        runSafe(commitsCmd),
        runSafe(branchCmd),
      ]);

      let diff = "";
      let diffError: string | undefined;
      if (isCommandSuccess(diffRes) && typeof diffRes.stdout === "string") {
        diff = diffRes.stdout;
      } else {
        diffError = describeBridgeFailure(diffCmd, diffRes);
        log(`[production-stage-deps] ${diffError}`);
      }

      let commitSubjects: string[] = [];
      if (isCommandSuccess(commitsRes) && typeof commitsRes.stdout === "string") {
        try {
          const parsed = JSON.parse(commitsRes.stdout) as {
            commits?: Array<{ messageHeadline?: string; message?: string }>;
          };
          if (Array.isArray(parsed.commits)) {
            commitSubjects = parsed.commits
              .map((c) => c.messageHeadline ?? c.message?.split(/\r?\n/)[0] ?? "")
              .filter((s) => s.length > 0);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[production-stage-deps] ${commitsCmd} returned invalid JSON: ${msg}`);
          commitSubjects = [];
        }
      } else {
        log(`[production-stage-deps] ${describeBridgeFailure(commitsCmd, commitsRes)}`);
      }

      let branchName = "";
      if (isCommandSuccess(branchRes) && typeof branchRes.stdout === "string") {
        try {
          const parsed = JSON.parse(branchRes.stdout) as { headRefName?: string };
          if (typeof parsed.headRefName === "string") {
            branchName = parsed.headRefName.trim();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[production-stage-deps] ${branchCmd} returned invalid JSON: ${msg}`);
          branchName = "";
        }
      } else {
        log(`[production-stage-deps] ${describeBridgeFailure(branchCmd, branchRes)}`);
      }

      return {
        diff,
        ...(diffError ? { diffError } : {}),
        allowlist: extractItemAllowlist(item),
        commitSubjects,
        branchName,
      };
    },

    async issueReviewerThread({ itemId, brief }): Promise<ReviewerVerdict> {
      const thread = threadStore.createThread({
        title: `Reviewer gate: ${itemId}`,
        initialPrompt: brief,
      });
      const deadline = now() + reviewerTimeoutMs;

      let dispatchError: string | null = null;
      let dispatchSettled = false;
      const dispatchPromise = dispatchChatTurn({
        threadId: thread.id,
        brief,
      })
        .then((res) => {
          if (!res.ok) {
            dispatchError = `Reviewer chat dispatch failed for thread ${thread.id} (HTTP ${res.status}).`;
          }
        })
        .catch((err) => {
          dispatchError =
            err instanceof Error
              ? err.message
              : `Reviewer chat dispatch threw for thread ${thread.id}: ${String(err)}`;
        })
        .finally(() => {
          dispatchSettled = true;
        });
      void dispatchPromise;

      while (true) {
        const record = await threadStore.getThread(thread.id);
        if (record) {
          if (record.status === "failed" || (record.status === "stopped" && dispatchSettled)) {
            return {
              threadId: thread.id,
              verdict: "FAIL",
              evidence: [
                `Reviewer thread ${thread.id} settled with status '${record.status}'${
                  record.error ? `: ${record.error}` : "."
                }`,
              ],
            };
          }

          if (record.status === "completed") {
            const assistantMessages = record.messages.filter(
              (m) => m.role === "assistant" && typeof m.content === "string"
            );
            const lastAssistant = assistantMessages[assistantMessages.length - 1];
            if (!lastAssistant) {
              return {
                threadId: thread.id,
                verdict: "FAIL",
                evidence: [
                  `Reviewer thread ${thread.id} completed without an assistant verdict message.`,
                ],
              };
            }
            return parseReviewerVerdictContent(thread.id, lastAssistant.content);
          }
        }

        if (dispatchError) {
          return {
            threadId: thread.id,
            verdict: "FAIL",
            evidence: [dispatchError],
          };
        }

        if (now() >= deadline) {
          return {
            threadId: thread.id,
            verdict: "FAIL",
            evidence: [
              `Reviewer thread ${thread.id} timed out after ${reviewerTimeoutMs}ms without settling.`,
            ],
          };
        }

        await sleep(reviewerPollIntervalMs);
      }
    },
  };

  const selfDeployDeps: SelfDeployVerifiedDeps = {
    async readCurrentState(): Promise<CurrentStateSnapshot> {
      const [deployRes, podsRes] = await Promise.all([
        runHostCommand(
          "kubectl -n local-agentic-sandbox get deployment web-ui -o jsonpath='{.spec.template.spec.containers[0].image}'",
          30
        ),
        runHostCommand("kubectl -n local-agentic-sandbox get pods -l app=web-ui -o json", 30),
      ]);

      const image =
        isCommandSuccess(deployRes) && typeof deployRes.stdout === "string"
          ? deployRes.stdout.trim().replace(/^'|'$/g, "")
          : "";
      const podMetrics =
        isCommandSuccess(podsRes) && typeof podsRes.stdout === "string"
          ? extractPodMetrics(podsRes.stdout)
          : { podStatus: "Unknown", podRestarts: -1, observedImage: "" };

      return {
        image,
        podStatus: podMetrics.podStatus,
        podRestarts: podMetrics.podRestarts,
      };
    },

    async bankRollbackTarget(tag: string): Promise<BankRollbackResult> {
      const cleanTag = tag.trim();
      if (!cleanTag) {
        return { banked: false, tag: "" };
      }

      const timestamp = new Date(now()).toISOString();
      const escapedTag = cleanTag.replace(/'/g, "''");
      const recordLine = `${timestamp} ROLLBACK_TARGET ${escapedTag}`;
      const cmd = [
        "$dir = 'docs/internal'",
        "if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
        `Add-Content -Path 'docs/internal/queue-steer-runlog.md' -Value '${recordLine}'`,
      ].join("; ");

      try {
        const res = await runHostCommand(cmd, 30);
        return { banked: isCommandSuccess(res), tag: cleanTag };
      } catch {
        return { banked: false, tag: cleanTag };
      }
    },

    async buildAndImport(targetTag: string, dryRun: boolean): Promise<BuildImportResult> {
      if (dryRun) {
        const currentState = await selfDeployDeps.readCurrentState();
        const plan = prepareSelfDeployPlan({
          currentImage: currentState.image,
          targetImage: formatImageRef(targetTag),
          healthUrl: "http://127.0.0.1:3001/api/sandbox-status",
          shadowMode: true,
        });
        return {
          built: false,
          imported: false,
          imagePresentInNode: false,
          detail: `Dry-run prepared for ${plan.targetImage} (${plan.steps.length} planned steps); no build or import executed.`,
        };
      }

      try {
        const res = await runHostCommand("node scripts/deploy-cluster.js web-ui", 600);
        const ok = isCommandSuccess(res);
        const stdout = typeof res.stdout === "string" ? res.stdout : "";
        const tagMatch = stdout.match(/local-agentic-sandbox-web-ui:(v-[a-z0-9-]+)/i);
        const builtTag = tagMatch?.[1];
        if (ok && !builtTag) {
          return {
            built: false,
            imported: false,
            imagePresentInNode: false,
            detail: "Could not determine built image tag from deploy-cluster.js output",
          };
        }
        const detail = ok
          ? (stdout || `Built and imported ${builtTag}`).trim()
          : (res.stderr || res.error || stdout || "deploy-cluster.js failed").trim();
        return {
          built: ok,
          imported: ok,
          imagePresentInNode: ok,
          ...(builtTag ? { builtTag: `local-agentic-sandbox-web-ui:${builtTag}` } : {}),
          detail,
        };
      } catch (err) {
        return {
          built: false,
          imported: false,
          imagePresentInNode: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async setImage(tag: string): Promise<{ ok: boolean }> {
      const imageRef = formatImageRef(tag);
      try {
        const res = await runHostCommand(
          `kubectl -n local-agentic-sandbox set image deployment/web-ui web-ui=${imageRef}`,
          60
        );
        return { ok: isCommandSuccess(res) };
      } catch {
        return { ok: false };
      }
    },

    async verifyDeployment(expectedTag: string): Promise<VerifyDeploymentResult> {
      const rolloutRes = await runHostCommand(
        "kubectl -n local-agentic-sandbox rollout status deployment/web-ui --timeout=120s",
        130
      );
      const rolloutSuccess = isCommandSuccess(rolloutRes);

      const podsRes = await runHostCommand(
        "kubectl -n local-agentic-sandbox get pods -l app=web-ui -o json",
        30
      );
      const podMetrics =
        isCommandSuccess(podsRes) && typeof podsRes.stdout === "string"
          ? extractPodMetrics(podsRes.stdout)
          : { podStatus: "Unknown", podRestarts: -1, observedImage: "" };
      const expectedRef = formatImageRef(expectedTag);
      const tagMatches =
        podMetrics.observedImage === expectedRef ||
        podMetrics.observedImage.endsWith(`:${expectedTag}`);
      const podRunningZeroRestarts =
        podMetrics.podStatus === "Running" && podMetrics.podRestarts === 0 && tagMatches;

      const gatewayRes = await runHostCommand(
        "(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/api/sandbox-status' -TimeoutSec 10).StatusCode",
        20
      );
      const gatewayStatus =
        isCommandSuccess(gatewayRes) && typeof gatewayRes.stdout === "string"
          ? Number.parseInt(gatewayRes.stdout.trim(), 10) || 0
          : 0;

      const threadsRes = await runHostCommand(
        "(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/api/threads' -TimeoutSec 10).StatusCode",
        20
      );
      const threadsStatus =
        isCommandSuccess(threadsRes) && typeof threadsRes.stdout === "string"
          ? Number.parseInt(threadsRes.stdout.trim(), 10) || 0
          : 0;
      const threadListLoads = threadsStatus === 200;

      const ok =
        rolloutSuccess && podRunningZeroRestarts && gatewayStatus === 200 && threadListLoads;

      let failedStep: string | undefined;
      let observed: string | undefined;
      if (!rolloutSuccess) {
        failedStep = "rollout_status";
        observed = (rolloutRes.stderr || rolloutRes.stdout || "rollout failed").trim();
      } else if (!podRunningZeroRestarts) {
        failedStep = "pod_health";
        observed = `phase=${podMetrics.podStatus} restarts=${podMetrics.podRestarts} image=${podMetrics.observedImage}`;
      } else if (gatewayStatus !== 200) {
        failedStep = "gateway_status";
        observed = `gateway=${gatewayStatus}`;
      } else if (!threadListLoads) {
        failedStep = "thread_list";
        observed = `threadsStatus=${threadsStatus}`;
      }

      return {
        ok,
        rolloutSuccess,
        podRunningZeroRestarts,
        gatewayStatus,
        threadListLoads,
        observedTag: podMetrics.observedImage || expectedRef,
        ...(failedStep ? { failedStep } : {}),
        ...(observed ? { observed } : {}),
      };
    },
  };

  return {
    flowMonitor,
    reviewerGate,
    resolveHeadSha: resolvePrHeadSha,
    resolveHeadShaDetailed: resolvePrHeadShaDetailed,
    selfDeploy: {
      deps: selfDeployDeps,
    },
  };
}
