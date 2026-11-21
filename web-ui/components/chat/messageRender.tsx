"use client";

import React, { useState } from "react";
import NextImage from "next/image";
import {
  Sparkles,
  Terminal,
  ShieldCheck,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Globe,
  FileText,
  FolderGit2,
  FileCode,
  ExternalLink,
  Download,
  RefreshCw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { classifyHostRunnerDisconnect } from "@/lib/liveActivity";
import { ExecutionTraceItem } from "../ExecutionTrace";
import { CompletionVerificationBadge } from "../CompletionVerificationBadge";
import { SvgViewer, SvgFileLink } from "../SvgViewer";
import { LiveRunBlock } from "../LiveRunBlock";
import { ThinkingPanel } from "../ThinkingPanel";
import { LiveActivityHeader } from "../LiveActivityHeader";
import { phaseLabelForTool } from "../../lib/liveActivity";
import { CodeBlock } from "../ArtifactRenderers";
import {
  isSvgCode,
  isSvgFilePath,
  resolveSvgUrl,
  wrapRawSvgInMarkdown,
  extractSvgsFromMessage,
  hasCompleteInlineSvg,
  extractCodeDeliverablesFromMessage,
} from "../../lib/svgUtils";
import { isMarkupOnlyToolCall, TURN_TOOL_MARKUP_MARKER } from "../../lib/toolCallIntegrity";
import {
  formatHumanReadableTrace,
  getServedByNote,
  extractFileWriteDiffsFromTraces,
  formatElapsedDuration,
  formatMessageTimestamp,
  displayRepoPath,
  displayBasename,
} from "../../lib/chatUtils";
import { CanvasDiffCard, CanvasFileOpenButton } from "../ArtifactCanvas";
import { resolveTurnStatusPhase } from "../../lib/chatStatus";
import { TaskManifest } from "../../lib/subagents/types";
import { formatFileSize } from "../../lib/chat/attachments";
import { CompactionPill } from "./compactionPill";
import type { ChatMessage } from "../ChatStream";

// UI-014: long user briefs (>320 chars or >6 lines) collapse behind a
// "Show full brief" toggle so a pasted job brief never walls off the thread.
const BRIEF_COLLAPSE_MAX_CHARS = 320;
const BRIEF_COLLAPSE_MAX_LINES = 6;

export function UserMessageContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible =
    content.length > BRIEF_COLLAPSE_MAX_CHARS ||
    content.split("\n").length > BRIEF_COLLAPSE_MAX_LINES;
  const markdown = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: ({ children }) => (
          <code className="px-1.5 py-0.5 rounded bg-blue-100/80 dark:bg-sky-900/40 text-blue-950 dark:text-sky-200 font-mono text-xs">
            {children}
          </code>
        ),
        p: ({ children }) => (
          <p className="mb-1 last:mb-0 leading-relaxed whitespace-pre-line text-blue-950 dark:text-sky-100">
            {children}
          </p>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
  if (!collapsible) return <>{markdown}</>;
  return (
    <div>
      <div className={expanded ? undefined : "relative max-h-[9rem] overflow-hidden"}>
        {markdown}
        {!expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-blue-50 dark:from-[#03151a] to-transparent" />
        )}
      </div>
      <div className="mt-2 -mb-1 border-t border-blue-200/70 dark:border-[rgba(56,189,248,0.25)]">
        <button
          type="button"
          data-testid="brief-collapse-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold text-blue-700 dark:text-[#bae6fd] hover:underline cursor-pointer"
        >
          {expanded ? (
            <>
              <span>Show less</span>
              <ChevronUp className="h-3.5 w-3.5" />
            </>
          ) : (
            <>
              <span>Show full brief ({content.length.toLocaleString()} chars)</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export interface ChatMessageItemProps {
  message: ChatMessage;
  idx: number;
  copiedMessageId: string | null;
  lastLinkedTaskMsgIndex: number;
  lastAssistantIndex: number;
  activeTask?: TaskManifest | null;
  liveTraces?: ExecutionTraceItem[];
  liveTurnTraces: ExecutionTraceItem[];
  isLoading: boolean;
  isStoppingTask: boolean;
  activeAssistantMsgId: string | null;
  completedTurnMsgId: string | null;
  streamStatus: string | null;
  turnStartedAtMs: number | null;
  lastActivityAtMs: number;
  expandedTraces: Record<string, boolean>;
  expandedProofs: Record<string, boolean>;
  hasResolvedDetachedTurn: boolean;
  activeModel: string;
  onPreviewImage: (url: string | null) => void;
  onCopyToClipboard: (text: string, id: string) => void;
  onRetry: () => void;
  onToggleProof: (proofKey: string) => void;
  onToggleTraces: (messageId: string) => void;
  onStopTask?: () => Promise<void> | void;
  onRunControlAction: (action: "pause" | "resume" | "restart") => void;
  onDeployRun?: (taskId: string) => Promise<void> | void;
}

export function ChatMessageItem({
  message: m,
  idx,
  copiedMessageId,
  lastLinkedTaskMsgIndex,
  lastAssistantIndex,
  activeTask,
  liveTraces,
  liveTurnTraces,
  isLoading,
  isStoppingTask,
  activeAssistantMsgId,
  completedTurnMsgId,
  streamStatus,
  turnStartedAtMs,
  lastActivityAtMs,
  expandedTraces,
  expandedProofs,
  hasResolvedDetachedTurn,
  activeModel,
  onPreviewImage,
  onCopyToClipboard,
  onRetry,
  onToggleProof,
  onToggleTraces,
  onStopTask,
  onRunControlAction,
  onDeployRun,
}: ChatMessageItemProps) {
  const isUser = m.role === "user";
  const isCopied = copiedMessageId === m.id;
  const isTaskHostMessage = idx === lastLinkedTaskMsgIndex && !!activeTask;
  const isSupersededTaskMessage = !!m.taskId && !isTaskHostMessage;

  if (isSupersededTaskMessage) {
    return null;
  }

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} space-y-1.5`}>
      {/* Attached Files rendering in user message */}
      {isUser && m.attachments && m.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 justify-end max-w-md">
          {m.attachments.map((att, aIdx) => (
            <div key={aIdx} className="relative group/att">
              {att.isImage && att.previewUrl ? (
                <div
                  onClick={() => onPreviewImage(att.previewUrl || null)}
                  className="cursor-pointer overflow-hidden rounded-2xl border border-slate-200 dark:border-zinc-700 shadow-xs"
                >
                  <NextImage
                    src={att.previewUrl}
                    alt={att.name}
                    width={80}
                    height={80}
                    unoptimized
                    className="h-20 w-20 object-cover hover:scale-105 transition-transform"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-zinc-850 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-200 text-xs font-medium shadow-xs">
                  <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="max-w-[140px] truncate">{att.name}</span>
                  <span className="text-[10px] text-slate-400">({formatFileSize(att.size)})</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* User Bubble: soft blue glass matching AGENTS.md 2.A */}
      {isUser ? (
        <div className="flex flex-col items-end max-w-[88%] sm:max-w-lg min-w-0">
          <div className="bg-blue-50/90 border border-blue-200 text-blue-950 dark:bg-[rgba(14,116,144,0.18)] dark:border-[rgba(56,189,248,0.32)] dark:text-[#e0f2fe] rounded-2xl px-4 py-3.5 shadow-xs text-sm font-normal leading-relaxed min-w-0">
            <div className="prose dark:prose-invert max-w-none break-words text-sm text-blue-950 dark:text-sky-100">
              <UserMessageContent content={m.content} />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-1 mr-1 text-[11px] text-slate-400 dark:text-zinc-400">
            <button
              type="button"
              data-testid="copy-user-message-btn"
              onClick={() => onCopyToClipboard(m.content, m.id)}
              className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
              title={copiedMessageId === m.id ? "Copied" : "Copy prompt"}
              aria-label={copiedMessageId === m.id ? "Copied" : "Copy prompt"}
            >
              {copiedMessageId === m.id ? (
                <>
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
            {m.timestamp && <span>{formatMessageTimestamp(m.timestamp)}</span>}
          </div>
        </div>
      ) : (
        /* Assistant Message View */
        <div className="w-full max-w-[840px] space-y-3">
          {((!isUser &&
            m.compactedThisTurn &&
            m.tokensBeforeCompaction !== undefined &&
            m.tokensAfterCompaction !== undefined) ||
            m.status === "incomplete" ||
            m.status === "error" ||
            m.status === "streaming") && (
            <div className="flex flex-wrap items-center gap-2">
              {!isUser &&
                m.compactedThisTurn &&
                m.tokensBeforeCompaction !== undefined &&
                m.tokensAfterCompaction !== undefined && (
                  <CompactionPill
                    tokensBeforeCompaction={m.tokensBeforeCompaction}
                    tokensAfterCompaction={m.tokensAfterCompaction}
                    compactionActions={m.compactionActions}
                  />
                )}
              {m.status === "streaming" && (
                <div
                  data-testid="message-status-badge"
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-800 text-[11px] font-mono font-medium text-emerald-800 dark:text-emerald-300 w-fit"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Streaming</span>
                </div>
              )}
              {m.status === "incomplete" && (
                <div
                  data-testid="message-status-badge"
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-300 dark:border-zinc-800 text-[11px] font-mono font-medium text-zinc-800 dark:text-zinc-300 w-fit"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse" />
                  <span>Incomplete</span>
                </div>
              )}
              {/* UI-007: recoverable-status affordance. The transient
            reconcile banner (ChatStream.tsx:1646-1652) only lives
            while actively reconciling; once reconciliation ends an
            'incomplete' turn must stay distinct from bare prose
            and expose a retry/resume control so the turn can be
            recovered from the UI. Presentation + affordance only:
            the persisted marker text and reconciliation behavior
            are untouched. */}
              {m.status === "incomplete" && !isLoading && (
                <button
                  type="button"
                  data-testid="incomplete-retry"
                  onClick={onRetry}
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-900/40 border border-zinc-400 dark:border-zinc-700 text-[11px] font-mono font-medium text-zinc-900 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800/60 transition-colors cursor-pointer"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>Retry turn</span>
                </button>
              )}
              {m.status === "error" && (
                <div
                  data-testid="message-status-badge"
                  className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-red-50 dark:bg-red-950/60 border border-red-300 dark:border-red-800 text-[11px] font-mono font-medium text-red-800 dark:text-red-300 w-fit"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  <span>Error</span>
                </div>
              )}
            </div>
          )}

          {/* Live Activity Header + Worker Reasoning Panel (Suppressed on task host message) */}
          {!isTaskHostMessage &&
            (() => {
              const isStreamingThis = Boolean(
                m.status === "streaming" || (isLoading && m.id === activeAssistantMsgId)
              );
              const shouldRenderThinking = Boolean(m.thought || isStreamingThis);
              const showDoneChip = Boolean(
                !isStreamingThis && completedTurnMsgId === m.id && typeof m.durationMs === "number"
              );
              if (!shouldRenderThinking && !showDoneChip) return null;

              const rawThought = m.thought || "";

              // uir-1 (UI-017): activity header inputs. The phase is the
              // latest observed tool in words; the round comes only from
              // the record's per-round token array when it exists (never
              // fabricated mid-turn).
              const liveLastTrace =
                liveTurnTraces.length > 0 ? liveTurnTraces[liveTurnTraces.length - 1] : null;
              const msgLastTrace =
                m.traces && m.traces.length > 0 ? m.traces[m.traces.length - 1] : null;
              const statusTool = streamStatus
                ? (streamStatus.match(
                    /^(?:Running|Executing|Invoking)\s+([a-zA-Z0-9_.\-]+)/i
                  )?.[1] ?? null)
                : null;
              const toolForPhase = liveLastTrace?.tool || msgLastTrace?.tool || statusTool;
              const phaseLabel = toolForPhase
                ? phaseLabelForTool(toolForPhase)
                : (resolveTurnStatusPhase({
                    isStreaming: true,
                    streamStatus,
                    hasThought: Boolean(m.thought),
                    hasContent: Boolean(m.content),
                  }) ?? "Starting turn…");
              const parsedTs = m.timestamp ? Date.parse(m.timestamp) : NaN;
              const startedAtMs =
                turnStartedAtMs ?? (Number.isNaN(parsedTs) ? lastActivityAtMs : parsedTs);
              const traceCount = Math.max(
                m.traces?.length ?? 0,
                isStreamingThis ? liveTurnTraces.length : 0
              );

              return (
                <div className="w-full space-y-2">
                  {isStreamingThis && (
                    <LiveActivityHeader
                      startedAtMs={startedAtMs}
                      lastActivityAtMs={lastActivityAtMs}
                      round={m.roundPromptTokens?.length}
                      traceCount={traceCount}
                      traces={
                        isStreamingThis ? (m.traces?.length ? m.traces : liveTurnTraces) : m.traces
                      }
                      phaseLabel={phaseLabel}
                      activityLabel={statusTool ? null : streamStatus}
                      isStreaming={isStreamingThis}
                    />
                  )}
                  {showDoneChip && (
                    <div
                      data-testid="turn-done-chip"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 text-[11px] font-mono font-medium text-emerald-800 dark:text-emerald-300 w-fit"
                    >
                      <span>{`✓ DONE · ${m.traces?.length ?? 0} ${(m.traces?.length ?? 0) === 1 ? "trace" : "traces"} · ${formatElapsedDuration(Math.round((m.durationMs as number) / 1000))}`}</span>
                    </div>
                  )}
                  {shouldRenderThinking && (
                    <ThinkingPanel
                      rawThought={rawThought}
                      isStreaming={isStreamingThis}
                      streamStatus={isStreamingThis ? streamStatus : null}
                      hasContent={Boolean(m.content && m.content.trim())}
                      defaultExpanded={Boolean(isStreamingThis || m.isStreaming)}
                      durationMs={m.thinkingDurationMs ?? m.durationMs}
                      phaseTimings={m.phaseTimings}
                      timestamp={m.timestamp}
                    />
                  )}
                </div>
              );
            })()}

          {/* Inline Expandable Sandbox & Telemetry Badges */}
          {!isUser && m.completionStamp === "completed-unverified" && (
            <div className="mb-2">
              <CompletionVerificationBadge stamp={m.completionStamp} gaps={m.verificationGaps} />
            </div>
          )}
          {!isUser &&
            m.traces &&
            m.traces.length > 0 &&
            (() => {
              const hasManyTraces = m.traces.length > 3;
              const isTracesExpanded = !!expandedTraces[m.id];
              const visibleTraces =
                hasManyTraces && !isTracesExpanded ? m.traces.slice(0, 2) : m.traces;

              return (
                <div className="mt-2.5 space-y-2 w-full">
                  {visibleTraces.map((trace, tIdx) => {
                    const proofKey = `${m.id}-${tIdx}`;
                    const isExpanded = !!expandedProofs[proofKey];
                    const human = formatHumanReadableTrace(trace);

                    return (
                      <div
                        key={tIdx}
                        className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/60 overflow-hidden shadow-xs transition-all"
                      >
                        <button
                          type="button"
                          onClick={() => onToggleProof(proofKey)}
                          aria-label={`Tool: ${trace.tool}`}
                          className="w-full px-3.5 py-2 flex items-center justify-between text-left hover:bg-slate-100/80 dark:hover:bg-zinc-850/80 transition-colors text-xs font-mono"
                        >
                          <div className="flex items-center gap-1.5 flex-wrap min-w-0 pr-2">
                            {human.badge === "browser" && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold shrink-0">
                                <Globe className="h-3.5 w-3.5" />
                                <span>Web</span>
                              </span>
                            )}
                            {human.badge === "host" && (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-semibold shrink-0">
                                <Terminal className="h-3.5 w-3.5" />
                                <span>Host</span>
                              </span>
                            )}
                            {human.badge === "workspace" && (
                              <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 font-semibold shrink-0">
                                <FolderGit2 className="h-3.5 w-3.5" />
                                <span>Workspace</span>
                              </span>
                            )}
                            {human.badge === "sandbox" && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold shrink-0">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                <span>Sandbox</span>
                              </span>
                            )}
                            <span className="text-slate-400 dark:text-zinc-400 shrink-0">•</span>
                            <span className="text-slate-700 dark:text-zinc-200 font-medium font-sans line-clamp-2 sm:truncate">
                              {human.title}
                            </span>
                            {human.duration && (
                              <>
                                <span className="text-slate-400 dark:text-zinc-400 shrink-0">
                                  •
                                </span>
                                <span className="text-slate-500 dark:text-zinc-400 shrink-0">
                                  {human.duration}
                                </span>
                              </>
                            )}
                          </div>

                          <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-sans font-medium shrink-0 ml-auto">
                            <span className="sm:hidden">{isExpanded ? "Hide" : "Proof"}</span>
                            <span className="hidden sm:inline">
                              {isExpanded ? "Hide Details (Proof)" : "Details · Expand Proof"}
                            </span>
                            {isExpanded ? (
                              <ChevronUp className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-slate-200 dark:border-zinc-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
                            <pre className="p-2 rounded bg-zinc-900 text-emerald-300 overflow-x-auto whitespace-pre-wrap">
                              {trace.args ? JSON.stringify(trace.args, null, 2) : ""}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {hasManyTraces && (
                    <button
                      type="button"
                      onClick={() => onToggleTraces(m.id)}
                      className="w-full py-1.5 px-3 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors flex items-center justify-center gap-1.5"
                    >
                      {isTracesExpanded ? (
                        <>
                          <ChevronUp className="h-3.5 w-3.5" />
                          <span>Collapse tool steps</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-3.5 w-3.5" />
                          <span>Show all {m.traces.length} tool steps</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })()}

          {/* Inline Live Run Block if this message is the designated task host */}
          {isTaskHostMessage && activeTask && (
            <LiveRunBlock
              task={activeTask}
              liveTraces={liveTraces}
              onStopRun={onStopTask}
              onPauseRun={() => onRunControlAction("pause")}
              onResumeRun={() => onRunControlAction("resume")}
              onRestartRun={() => onRunControlAction("restart")}
              onDeployRun={onDeployRun}
              isStopping={isStoppingTask}
            />
          )}

          {/* Text Markdown Content (Suppress if task host message or disconnected 'Started autonomous...') */}
          {!isTaskHostMessage &&
            m.content &&
            (!m.taskId || !m.content.includes("Started autonomous engineering run.")) &&
            (() => {
              const hostDisconnect = classifyHostRunnerDisconnect(m.content);
              const rawRenderedContent =
                hostDisconnect.kind !== "none" ? hostDisconnect.remainingContent : m.content;
              const renderedContent =
                m.role === "assistant" && isMarkupOnlyToolCall(rawRenderedContent)
                  ? TURN_TOOL_MARKUP_MARKER
                  : rawRenderedContent;
              return (
                <>
                  {hostDisconnect.kind !== "none" && (
                    <div
                      data-testid="host-runner-disconnect-status"
                      className={`mb-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
                        hostDisconnect.kind === "recovered"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                          : "border-zinc-700 bg-black text-zinc-400"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          hostDisconnect.kind === "recovered" ? "bg-emerald-500" : "bg-zinc-400"
                        }`}
                      />
                      <span>{hostDisconnect.summary}</span>
                    </div>
                  )}
                  {renderedContent ? (
                    <div className="text-[15px] leading-[1.6] max-w-[72ch] text-[#1d1b20] dark:text-[#e6e0e9] font-sans">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code: ({
                            inline,
                            className,
                            children,
                            ...props
                          }: React.ComponentPropsWithoutRef<"code"> & {
                            inline?: boolean;
                          }) => {
                            const match = /language-(\w+)/.exec(className || "");
                            const codeString = String(children).replace(/\n$/, "");
                            const isSvg = isSvgCode(codeString, match ? match[1] : undefined);
                            if (!inline && (match || codeString.includes("\n") || isSvg)) {
                              return (
                                <CodeBlock
                                  language={match ? match[1] : isSvg ? "svg" : "bash"}
                                  code={codeString}
                                />
                              );
                            }
                            if (inline && isSvgFilePath(codeString)) {
                              return (
                                <SvgFileLink href={resolveSvgUrl(codeString)} rawHref={codeString}>
                                  {children}
                                </SvgFileLink>
                              );
                            }
                            return (
                              <code
                                className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-emerald-700 dark:text-emerald-400 font-mono text-xs border border-slate-200 dark:border-zinc-700 break-all max-w-full"
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          p: ({ children }) => (
                            <p className="mb-3 last:mb-0 leading-[1.6] text-slate-900 dark:text-zinc-100">
                              {children}
                            </p>
                          ),
                          ul: ({ children }) => (
                            <ul className="list-disc pl-5 my-3 space-y-1.5 leading-[1.6] text-slate-900 dark:text-zinc-100">
                              {children}
                            </ul>
                          ),
                          ol: ({ children, start }) => (
                            <ol
                              start={start}
                              className="list-decimal pl-5 my-3 space-y-1.5 leading-[1.6] text-slate-900 dark:text-zinc-100"
                            >
                              {children}
                            </ol>
                          ),
                          li: ({ children }) => <li className="leading-[1.6]">{children}</li>,
                          blockquote: ({ children }) => (
                            <blockquote className="border-l-4 border-emerald-500 bg-slate-50/80 dark:bg-zinc-900/60 pl-3.5 py-1.5 my-3 italic text-slate-700 dark:text-zinc-300 rounded-r-xl">
                              {children}
                            </blockquote>
                          ),
                          table: ({ children }) => (
                            <div className="overflow-x-auto my-3 rounded-xl border border-slate-200 dark:border-zinc-800">
                              <table className="min-w-full text-left text-xs divide-y divide-slate-200 dark:divide-zinc-800">
                                {children}
                              </table>
                            </div>
                          ),
                          thead: ({ children }) => (
                            <thead className="bg-[#f4eff4] dark:bg-[#2b2930] text-slate-900 dark:text-zinc-100 font-semibold">
                              {children}
                            </thead>
                          ),
                          tbody: ({ children }) => (
                            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800 bg-white dark:bg-zinc-900">
                              {children}
                            </tbody>
                          ),
                          tr: ({ children }) => (
                            <tr className="hover:bg-slate-50/50 dark:hover:bg-zinc-850/50 transition-colors">
                              {children}
                            </tr>
                          ),
                          th: ({ children }) => (
                            <th className="px-3.5 py-2 font-semibold text-xs tracking-wider">
                              {children}
                            </th>
                          ),
                          td: ({ children }) => (
                            <td className="px-3.5 py-2 text-xs leading-relaxed text-slate-800 dark:text-zinc-200">
                              {children}
                            </td>
                          ),
                          h1: ({ children }) => (
                            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100 mt-4 mb-2 first:mt-0">
                              {children}
                            </h1>
                          ),
                          h2: ({ children }) => (
                            <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-zinc-100 mt-3.5 mb-1.5">
                              {children}
                            </h2>
                          ),
                          h3: ({ children }) => (
                            <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-zinc-100 mt-3 mb-1">
                              {children}
                            </h3>
                          ),
                        }}
                      >
                        {wrapRawSvgInMarkdown(renderedContent)}
                      </ReactMarkdown>
                      {m.status === "streaming" && (
                        <span
                          data-testid="stream-cursor"
                          aria-hidden="true"
                          className="text-emerald-400 animate-pulse font-bold"
                        >
                          ▍
                        </span>
                      )}
                    </div>
                  ) : null}

                  {/* Copy Response Action: phone-tappable button copying raw assistant markdown */}
                  <div className="flex items-center gap-2 pt-1 text-xs">
                    <button
                      type="button"
                      data-testid="copy-response-btn"
                      onClick={() => onCopyToClipboard(m.content, m.id)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors text-xs font-medium cursor-pointer"
                      title={isCopied ? "Copied" : "Copy response"}
                      aria-label={isCopied ? "Copied" : "Copy response"}
                    >
                      {isCopied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            Copied
                          </span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              );
            })()}

          {/* Tool Generated SVG Visual Artifacts & Code Deliverables */}
          {!isTaskHostMessage && (
            <>
              {(() => {
                if (hasCompleteInlineSvg(m.content)) return null;
                const messageSvgs = extractSvgsFromMessage(m);
                if (messageSvgs.length === 0) return null;
                return (
                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-4 not-prose w-full">
                    {messageSvgs.map((svg) => (
                      <div key={svg.id} className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                          <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                            <Sparkles className="h-3.5 w-3.5" />
                            <span>Rendered Vector Diagram: {svg.title}</span>
                          </span>
                        </div>
                        <SvgViewer
                          code={svg.code}
                          url={svg.url}
                          title={svg.title}
                          initialTab="preview"
                          allowFullscreen={true}
                        />
                      </div>
                    ))}
                  </div>
                );
              })()}

              {(() => {
                const codeDeliverables = extractCodeDeliverablesFromMessage(m);
                if (codeDeliverables.length === 0) return null;
                return (
                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-4 not-prose w-full">
                    {codeDeliverables.map((item) => (
                      <div key={item.id} className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 dark:text-zinc-400">
                          <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                            <FileCode className="h-3.5 w-3.5" />
                            <span>Delivered Code File: {item.title}</span>
                          </span>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                          >
                            <span>Open Raw</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <CodeBlock language={item.language} code={item.code} filename={item.path} />
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          )}

          {/* Generated File Cards (Download / Open) */}
          {!isUser && m.attachments && m.attachments.length > 0 && (
            <div className="flex flex-col gap-2.5 pt-1 w-full max-w-lg">
              {m.attachments.map((att, aIdx) => {
                const fileRelPath = att.previewUrl || att.name;
                const isHtml = att.name.toLowerCase().endsWith(".html") || att.type === "text/html";
                const isSvg =
                  att.name.toLowerCase().endsWith(".svg") || att.type === "image/svg+xml";
                const canOpenInTab = isHtml || isSvg;
                const downloadUrl = `/api/files?path=${encodeURIComponent(fileRelPath)}&download=1`;
                const openUrl = `/api/files?path=${encodeURIComponent(fileRelPath)}`;

                return (
                  <div
                    key={aIdx}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-emerald-600 dark:text-emerald-400 shrink-0">
                        <FileCode className="h-5 w-5" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span
                          className="font-semibold text-sm text-slate-900 dark:text-zinc-100 truncate"
                          title={att.name}
                        >
                          {att.name}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-zinc-400">
                          {formatFileSize(att.size)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {canOpenInTab && <CanvasFileOpenButton name={att.name} url={openUrl} />}
                      {canOpenInTab && (
                        <a
                          href={openUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-[44px] min-w-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                          title="Open in new tab"
                        >
                          <ExternalLink className="h-4 w-4" />
                          <span>Open</span>
                        </a>
                      )}
                      <a
                        href={downloadUrl}
                        download={att.name}
                        className="min-h-[44px] min-w-[44px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                        title="Download file"
                      >
                        <Download className="h-4 w-4" />
                        <span>Download</span>
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Chat Diff Cards for File Writes & Patches */}
          {(() => {
            if (isUser) return null;

            type TurnDiffEntry = {
              path: string;
              diff: string;
              diffFull?: string;
              addedLines: number;
              removedLines: number;
              truncated?: boolean;
              totalDiffLines?: number;
              omittedLines?: number;
            };
            const normalizeDiffPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
            const traceDiffs: TurnDiffEntry[] = extractFileWriteDiffsFromTraces(m.traces).map(
              (d) => ({
                path: d.path,
                diff: d.diffPreview,
                diffFull: d.diffFull,
                addedLines: d.addedLines,
                removedLines: d.removedLines,
                truncated: d.diffPreview.includes("more lines"),
              })
            );
            const serverDiffs: TurnDiffEntry[] = Array.isArray(m.diffs) ? m.diffs : [];
            const mergedMap = new Map<string, TurnDiffEntry>();
            for (const d of traceDiffs) {
              mergedMap.set(normalizeDiffPath(d.path), d);
            }
            for (const d of serverDiffs) {
              const key = normalizeDiffPath(d.path);
              const existing = mergedMap.get(key);
              const isUnified = d.removedLines > 0 || /^@@\s+-\d+/m.test(d.diff);
              if (!existing || isUnified) {
                mergedMap.set(key, d);
              }
            }
            const fileDiffs = Array.from(mergedMap.values());

            if (fileDiffs.length === 0) return null;

            return (
              <div className="flex flex-col gap-2 pt-1 w-full max-w-xl">
                {/* UI-024: the canvas gets the FULL diff (diffFull ?? the
              stored diff for server-side turn diffs); the inline
              cards below keep the capped preview. */}
                <CanvasDiffCard
                  diffs={fileDiffs.map((d) => ({
                    path: d.path,
                    diff: d.diffFull ?? d.diff,
                    addedLines: d.addedLines,
                    removedLines: d.removedLines,
                  }))}
                />
              </div>
            );
          })()}

          {/* Grounded File Citation Card matching Mockup 4 */}
          {m.traces &&
            m.traces.some((t) => {
              const traceItem = t as ExecutionTraceItem & { name?: string };
              return (
                traceItem.tool?.includes("file") ||
                Boolean(traceItem.args?.path) ||
                (Boolean(traceItem.name) && String(traceItem.name).includes(".ts"))
              );
            }) && (
              <div className="flex flex-wrap gap-2 pt-1 max-w-sm">
                {m.traces
                  .filter((t) => {
                    const traceItem = t as ExecutionTraceItem & { name?: string };
                    return (
                      Boolean(traceItem.args?.path) ||
                      (Boolean(traceItem.name) && String(traceItem.name).includes(".ts"))
                    );
                  })
                  .slice(0, 3)
                  .map((t, cIdx) => {
                    const traceItem = t as ExecutionTraceItem & { name?: string };
                    const pathLabel =
                      typeof traceItem.args?.path === "string"
                        ? traceItem.args.path
                        : traceItem.name;
                    if (!pathLabel) return null;
                    return (
                      <div
                        key={cIdx}
                        className="flex items-center justify-between w-full p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 shadow-xs text-xs font-mono text-slate-800 dark:text-zinc-200"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          <div className="min-w-0">
                            <div className="font-semibold truncate">
                              {displayBasename(pathLabel)}
                            </div>
                            <div className="text-[10px] text-zinc-400 truncate">
                              {displayRepoPath(pathLabel)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0 ml-2">
                          <a
                            href={resolveSvgUrl(pathLabel)}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
                            title="Open file"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                          <button
                            type="button"
                            onClick={() => onCopyToClipboard(pathLabel, `${m.id}-${cIdx}`)}
                            className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200"
                            title="Copy path"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

          {/* Partial output stopped indicator */}
          {m.isStopped && (
            <div className="inline-block px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-850 text-slate-600 dark:text-zinc-400 text-xs font-mono border border-slate-200 dark:border-zinc-800">
              • Stopped
            </div>
          )}

          {/* Detached turn resolved notification */}
          {hasResolvedDetachedTurn && idx === lastAssistantIndex && (
            <div
              data-testid="turn-resolved-detached"
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 text-xs font-medium"
            >
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>Turn completed server-side and reconciled</span>
            </div>
          )}

          {/* Per-message served model indicator: only display when served model differs from selected */}
          {(() => {
            if (m.id === "initial-welcome") return null;
            const note = getServedByNote(m.modelUsed, m.selectedModel ?? activeModel);
            if (!note) return null;
            return (
              <div
                data-testid="served-by-note"
                className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-zinc-400 pt-0.5"
              >
                <Sparkles className="h-2.5 w-2.5 text-emerald-500/70" />
                <span>{note}</span>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
