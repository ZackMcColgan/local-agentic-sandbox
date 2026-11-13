"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  Monitor,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-react";
import {
  availableViews,
  buildDiffRows,
  countDiffLines,
  diffTotals,
  splitUnifiedDiff,
  type CanvasArtifact,
  type CanvasDiffFile,
  type CanvasView,
} from "../lib/canvas";
import { useCanvas } from "./CanvasContext";
import { highlightTokens } from "./ArtifactRenderers";
import { SvgViewer } from "./SvgViewer";
import { isSvgCode } from "../lib/svgUtils";
import { copyText } from "../lib/clipboard";
import { inferAttachmentMimeType } from "../lib/attachmentMime";

const VIEW_LABELS: Record<CanvasView, string> = {
  preview: "Preview",
  code: "Code",
  diff: "Diff",
};

/** Build canvas diff files from the chat cards' per-file diff records. */
export function buildDiffFiles(
  diffs: Array<{ path: string; diff: string }>
): CanvasDiffFile[] {
  const files: CanvasDiffFile[] = [];
  for (const item of diffs) {
    if (!item.diff) continue;
    if (item.diff.includes("diff --git")) {
      files.push(...splitUnifiedDiff(item.diff, item.path));
    } else {
      const counts = countDiffLines(item.diff);
      files.push({
        path: item.path,
        diff: item.diff,
        addedLines: counts.addedLines,
        removedLines: counts.removedLines,
      });
    }
  }
  return files;
}

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

function combinedDiff(artifact: Extract<CanvasArtifact, { kind: "diff" }>): string {
  return artifact.files.map((f) => f.diff).join("\n");
}

/**
 * The "N files changed — View diff" door rendered above a message's inline
 * diff cards. The inline cards stay as the summary; this opens the full,
 * untruncated diff in the canvas. Renders nothing when the canvas is
 * disabled or no provider is mounted.
 */
export function CanvasDiffCard({
  diffs,
  title,
}: {
  diffs: Array<{ path: string; diff: string; addedLines?: number; removedLines?: number }>;
  title?: string;
}) {
  const canvas = useCanvas();
  const files = useMemo(() => buildDiffFiles(diffs), [diffs]);
  const totals = useMemo(() => diffTotals(files), [files]);
  const artifact = useMemo<CanvasArtifact | null>(() => {
    if (files.length === 0) return null;
    return {
      kind: "diff",
      id: `diff:${files.map((f) => f.path).join("|")}`,
      title: title || "Changes",
      files,
    };
  }, [files, title]);

  useEffect(() => {
    if (artifact) canvas?.syncArtifact(artifact);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact]);

  if (!canvas?.enabled || !artifact) return null;

  return (
    <div
      data-testid="canvas-diff-card"
      className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xs w-full"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-emerald-600 dark:text-emerald-400 shrink-0">
          <FileCode className="h-5 w-5" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
            {totals.fileCount} {totals.fileCount === 1 ? "file" : "files"} changed
          </span>
          <span className="text-xs font-mono">
            <span className="text-emerald-600 dark:text-emerald-400">+{totals.addedLines}</span>{" "}
            <span className="text-rose-600 dark:text-rose-400">−{totals.removedLines}</span>
          </span>
        </div>
      </div>
      <button
        type="button"
        data-testid="canvas-diff-open"
        onClick={() => canvas.openCanvas(artifact, "diff")}
        className="min-h-[44px] px-3.5 rounded-xl border border-emerald-600/40 dark:border-emerald-500/40 text-emerald-700 dark:text-emerald-300 text-xs font-semibold flex items-center gap-1 shrink-0 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors"
      >
        <span>View diff</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * The Open door for generated-file cards whose content lives behind a
 * workspace URL (no inline code). Renders nothing when the canvas is
 * disabled or no provider is mounted — the card's own links stay as-is.
 */
export function CanvasFileOpenButton({
  name,
  url,
}: {
  name: string;
  url: string;
}) {
  const canvas = useCanvas();
  if (!canvas?.enabled) return null;
  const artifact: CanvasArtifact = {
    kind: "file",
    id: `file:${name}`,
    filename: name,
    code: "",
    sourceUrl: url,
  };
  return (
    <button
      type="button"
      data-testid="canvas-file-open"
      onClick={() => canvas.openCanvas(artifact, "preview")}
      className="min-h-[44px] min-w-[44px] px-3.5 py-2 rounded-xl border border-emerald-600/40 dark:border-emerald-500/40 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
      title="Open in canvas"
    >
      <span>Open</span>
      <ChevronRight className="h-4 w-4" />
    </button>
  );
}

function DiffRows({ file }: { file: CanvasDiffFile }) {
  const rows = useMemo(() => buildDiffRows(file.diff), [file.diff]);
  return (
    <div className="min-w-max font-mono text-[11px] leading-5">
      {rows.map((row, idx) => {
        let rowClass = "text-slate-700 dark:text-zinc-300";
        let sign = " ";
        if (row.kind === "add") {
          rowClass = "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
          sign = "+";
        } else if (row.kind === "del") {
          rowClass = "bg-rose-500/10 text-rose-800 dark:text-rose-300";
          sign = "−";
        } else if (row.kind === "hunk") {
          rowClass = "bg-sky-500/10 text-sky-700 dark:text-sky-300 font-semibold";
        } else if (row.kind === "meta") {
          rowClass = "text-slate-400 dark:text-zinc-500";
        }
        return (
          <div key={idx} data-testid="canvas-diff-row" className={`flex whitespace-pre ${rowClass}`}>
            <span className="w-12 shrink-0 text-right pr-2 select-none text-slate-400 dark:text-zinc-600">
              {row.oldLine ?? ""}
            </span>
            <span className="w-12 shrink-0 text-right pr-2 select-none text-slate-400 dark:text-zinc-600">
              {row.newLine ?? ""}
            </span>
            <span className="w-4 shrink-0 select-none text-center">{sign}</span>
            <span>{row.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function CanvasDiffView({
  artifact,
}: {
  artifact: Extract<CanvasArtifact, { kind: "diff" }>;
}) {
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    setSelected(0);
  }, [artifact.id]);
  const totals = diffTotals(artifact.files);
  const file = artifact.files[Math.min(selected, artifact.files.length - 1)];

  const fileButtonClass = (active: boolean) =>
    active
      ? "border-emerald-600 dark:border-emerald-400 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40"
      : "border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 bg-white dark:bg-zinc-900";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-1.5 text-[11px] font-mono text-slate-500 dark:text-zinc-400 border-b border-slate-100 dark:border-zinc-800 shrink-0">
        {totals.fileCount} {totals.fileCount === 1 ? "file" : "files"} ·{" "}
        <span className="text-emerald-600 dark:text-emerald-400">+{totals.addedLines}</span>{" "}
        <span className="text-rose-600 dark:text-rose-400">−{totals.removedLines}</span>
        <span className="hidden sm:inline"> · unified · every line, nothing truncated</span>
      </div>

      {/* Mobile: file chips replace the rail */}
      <div className="flex lg:hidden gap-2 overflow-x-auto px-3 py-2 border-b border-slate-100 dark:border-zinc-800 shrink-0">
        {artifact.files.map((f, idx) => (
          <button
            key={`${f.path}-${idx}`}
            type="button"
            data-testid="canvas-diff-chip"
            onClick={() => setSelected(idx)}
            className={`min-h-[44px] px-3 rounded-xl border text-[11px] font-mono whitespace-nowrap flex items-center gap-1.5 ${fileButtonClass(idx === selected)}`}
          >
            <span>{f.path.split("/").pop()}</span>
            <span className="text-emerald-600 dark:text-emerald-400">+{f.addedLines}</span>
            <span className="text-rose-600 dark:text-rose-400">−{f.removedLines}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Desktop: file rail */}
        <div className="hidden lg:flex flex-col w-60 shrink-0 border-r border-slate-200 dark:border-zinc-800 overflow-y-auto py-2">
          {artifact.files.map((f, idx) => (
            <button
              key={`${f.path}-${idx}`}
              type="button"
              data-testid="canvas-diff-rail-file"
              onClick={() => setSelected(idx)}
              className={`px-3 py-2 text-left text-[11px] font-mono flex items-center justify-between gap-2 border-l-2 ${
                idx === selected
                  ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-slate-900 dark:text-zinc-100"
                  : "border-transparent text-slate-600 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="truncate">{f.path}</span>
              <span className="shrink-0">
                <span className="text-emerald-600 dark:text-emerald-400">+{f.addedLines}</span>{" "}
                <span className="text-rose-600 dark:text-rose-400">−{f.removedLines}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0 overflow-auto bg-white dark:bg-zinc-950 p-2">
          {file ? (
            <>
              <div className="px-1 pb-2 text-[11px] font-mono font-semibold text-slate-800 dark:text-zinc-200 min-w-max">
                {file.path}
              </div>
              <DiffRows file={file} />
            </>
          ) : (
            <div className="p-4 text-xs text-slate-500 dark:text-zinc-400 font-mono">
              No diff content.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CanvasFileView({
  artifact,
  view,
  refreshKey,
  device,
}: {
  artifact: Extract<CanvasArtifact, { kind: "file" }>;
  view: CanvasView;
  refreshKey: number;
  device: "full" | "phone";
}) {
  const isSvg = isSvgCode(artifact.code, artifact.language) || (artifact.filename || "").toLowerCase().endsWith(".svg");

  if (view === "code") {
    if (!artifact.code) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6 text-xs text-slate-500 dark:text-zinc-400 font-mono">
          This file loads from the workspace — use Preview.
        </div>
      );
    }
    const lines = artifact.code.split("\n");
    return (
      <div className="flex-1 min-h-0 overflow-auto bg-slate-50 dark:bg-zinc-900">
        <div className="flex p-3.5 text-xs font-mono leading-relaxed min-w-max">
          <div className="select-none pr-3.5 mr-3.5 border-r border-slate-200 dark:border-zinc-800 text-slate-400 dark:text-zinc-600 text-right text-[11px] font-mono leading-5">
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="text-slate-900 dark:text-zinc-100 flex-1 whitespace-pre">
            <code>{highlightTokens(artifact.code, (artifact.language || "").toLowerCase())}</code>
          </pre>
        </div>
      </div>
    );
  }

  // Preview — the existing sandboxed rendering paths, unchanged.
  const frame = (
    <div className={`h-full ${device === "phone" ? "lg:w-[390px] lg:mx-auto lg:border-x lg:border-slate-200 lg:dark:border-zinc-800" : "w-full"}`}>
      {isSvg && artifact.code ? (
        <SvgViewer
          key={refreshKey}
          code={artifact.code}
          title={artifact.filename}
          initialTab="preview"
          allowFullscreen={false}
        />
      ) : (
        <iframe
          key={refreshKey}
          srcDoc={artifact.code ? artifact.code : undefined}
          src={!artifact.code ? artifact.sourceUrl : undefined}
          sandbox="allow-scripts"
          className="w-full h-full min-h-[320px] border-0 bg-white"
          title={artifact.filename || "Artifact preview"}
        />
      )}
    </div>
  );
  return <div className="flex-1 min-h-0 overflow-auto bg-white dark:bg-zinc-950">{frame}</div>;
}

/**
 * The canvas surface itself. On mobile it is a full-screen sheet over the
 * chat (‹ Chat returns to the exact prior scroll position); on desktop it is
 * a split pane — the chat column narrows beside it and stays live.
 */
export function ArtifactCanvasPane() {
  const canvas = useCanvas();
  const [refreshKey, setRefreshKey] = useState(0);
  const [device, setDevice] = useState<"full" | "phone">("full");
  const [copied, setCopied] = useState(false);

  const artifact = canvas?.openArtifact ?? null;
  useEffect(() => {
    setDevice("full");
    setCopied(false);
  }, [artifact?.id]);

  if (!canvas || !canvas.enabled || !artifact) return null;

  // The view list comes from the shared classification in lib/canvas, so the
  // canvas never disagrees with the inline renderer about what a file is.
  // A URL-backed file (no inline code) is preview-only.
  const resolvedViews: CanvasView[] =
    artifact.kind === "diff"
      ? ["diff"]
      : !artifact.code && artifact.sourceUrl
        ? ["preview"]
        : availableViews(artifact);
  const activeView: CanvasView = resolvedViews.includes(canvas.view)
    ? canvas.view
    : resolvedViews[0];
  const title = artifact.kind === "file" ? artifact.filename : artifact.title;

  const copyableText =
    artifact.kind === "diff"
      ? combinedDiff(artifact)
      : artifact.code;

  const handleCopy = async () => {
    if (!copyableText) return;
    const ok = await copyText(copyableText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (artifact.kind === "diff") {
      downloadText("changes.diff", combinedDiff(artifact), "text/plain");
      return;
    }
    if (artifact.code) {
      const name = artifact.filename || "snippet.txt";
      downloadText(name, artifact.code, inferAttachmentMimeType(name));
      return;
    }
    if (artifact.sourceUrl) {
      const a = document.createElement("a");
      a.href = artifact.sourceUrl;
      a.download = artifact.filename || "file";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const handlePopOut = () => {
    if (typeof window === "undefined") return;
    if (artifact.kind === "file" && !artifact.code && artifact.sourceUrl) {
      window.open(artifact.sourceUrl, "_blank", "noopener,noreferrer");
      return;
    }
    const text = artifact.kind === "diff" ? combinedDiff(artifact) : artifact.code;
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const tabButton = (v: CanvasView) => (
    <button
      key={v}
      type="button"
      data-testid="canvas-tab"
      aria-pressed={activeView === v}
      onClick={() => canvas.setView(v)}
      className={`flex-1 lg:flex-none min-h-[44px] lg:min-h-[36px] px-4 rounded-xl text-xs font-semibold transition-colors ${
        activeView === v
          ? "bg-white dark:bg-zinc-700 text-emerald-800 dark:text-emerald-300 shadow-xs"
          : "text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200"
      }`}
    >
      {VIEW_LABELS[v]}
    </button>
  );

  const iconBtnClass =
    "h-11 w-11 lg:h-9 lg:w-9 rounded-xl border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors shrink-0";

  return (
    <section
      data-testid="canvas-pane"
      aria-label={`Canvas: ${title}`}
      className="fixed inset-0 z-[60] flex flex-col bg-white dark:bg-zinc-950 lg:relative lg:inset-auto lg:z-auto lg:w-[min(880px,58%)] lg:shrink-0 lg:border-l lg:border-slate-200 lg:dark:border-zinc-800 lg:h-full"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 sm:px-3.5 py-2 border-b border-slate-200 dark:border-zinc-800 shrink-0">
        <button
          type="button"
          data-testid="canvas-close"
          onClick={canvas.closeCanvas}
          className="lg:hidden min-h-[44px] px-2 -ml-1 flex items-center gap-0.5 text-emerald-700 dark:text-emerald-300 text-sm font-semibold shrink-0"
        >
          <ChevronLeft className="h-5 w-5" />
          <span>Chat</span>
        </button>
        <span
          className="font-mono text-xs font-semibold text-slate-800 dark:text-zinc-200 truncate min-w-0"
          title={title}
        >
          {title}
        </span>

        {resolvedViews.length > 1 && (
          <div className="hidden lg:flex items-center rounded-xl bg-slate-200/70 dark:bg-zinc-800 p-0.5 ml-2 shrink-0">
            {resolvedViews.map(tabButton)}
          </div>
        )}

        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {activeView === "preview" && artifact.kind === "file" && (
            <>
              <div className="hidden lg:flex items-center rounded-xl bg-slate-200/70 dark:bg-zinc-800 p-0.5 mr-1">
                <button
                  type="button"
                  onClick={() => setDevice("full")}
                  className={`h-8 w-9 rounded-lg flex items-center justify-center ${device === "full" ? "bg-white dark:bg-zinc-700 text-emerald-700 dark:text-emerald-300" : "text-slate-500 dark:text-zinc-400"}`}
                  title="Full width preview"
                  aria-label="Full width preview"
                >
                  <Monitor className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDevice("phone")}
                  className={`h-8 w-9 rounded-lg flex items-center justify-center ${device === "phone" ? "bg-white dark:bg-zinc-700 text-emerald-700 dark:text-emerald-300" : "text-slate-500 dark:text-zinc-400"}`}
                  title="Phone width preview"
                  aria-label="Phone width preview"
                >
                  <Smartphone className="h-4 w-4" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setRefreshKey((k) => k + 1)}
                className={iconBtnClass}
                title="Refresh preview"
                aria-label="Refresh preview"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </>
          )}
          {copyableText && (
            <button
              type="button"
              onClick={handleCopy}
              className={iconBtnClass}
              title={artifact.kind === "diff" ? "Copy full diff" : "Copy content"}
              aria-label={artifact.kind === "diff" ? "Copy full diff" : "Copy content"}
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className={iconBtnClass}
            title="Download"
            aria-label="Download"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handlePopOut}
            className={`${iconBtnClass} hidden sm:flex`}
            title="Open in new tab"
            aria-label="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="canvas-close-desktop"
            onClick={canvas.closeCanvas}
            className={`${iconBtnClass} hidden lg:flex`}
            title="Close canvas"
            aria-label="Close canvas"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      {artifact.kind === "diff" ? (
        <CanvasDiffView artifact={artifact} />
      ) : (
        <CanvasFileView
          artifact={artifact}
          view={activeView}
          refreshKey={refreshKey}
          device={device}
        />
      )}

      {/* Mobile: view tabs live in a bottom bar with full-size targets */}
      {resolvedViews.length > 1 && (
        <div className="lg:hidden flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-zinc-800 shrink-0 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          {resolvedViews.map(tabButton)}
        </div>
      )}
    </section>
  );
}
