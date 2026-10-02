"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Eye,
  Code,
  Copy,
  Check,
  Download,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Loader2,
  AlertCircle,
  FileCode,
  Sparkles
} from "lucide-react";
import { sanitizeSvg } from "@/lib/svgUtils";

export interface SvgViewerProps {
  code?: string;
  url?: string;
  title?: string;
  initialTab?: "preview" | "code";
  allowFullscreen?: boolean;
  className?: string;
}

type BgMode = "white" | "dark" | "grid";

export function SvgViewer({
  code: initialCode,
  url,
  title = "SVG Vector Graphic",
  initialTab = "preview",
  allowFullscreen = true,
  className = ""
}: SvgViewerProps) {
  const [activeTab, setActiveTab] = useState<"preview" | "code">(initialTab);
  const [rawSvg, setRawSvg] = useState<string>(initialCode || "");
  const [loading, setLoading] = useState<boolean>(!initialCode && !!url);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(1.0);
  const [bgMode, setBgMode] = useState<BgMode>("white");
  const [copied, setCopied] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Fetch SVG from url if code was not provided directly
  useEffect(() => {
    if (initialCode) {
      setRawSvg(initialCode);
      setLoading(false);
      return;
    }

    if (url) {
      let isMounted = true;
      setLoading(true);
      setFetchError(null);

      fetch(url)
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`Failed to load SVG: HTTP ${res.status}`);
          }
          const text = await res.text();
          if (isMounted) {
            setRawSvg(text);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (isMounted) {
            setFetchError(err.message);
            setLoading(false);
          }
        });

      return () => {
        isMounted = false;
      };
    }
  }, [initialCode, url]);

  // Close fullscreen on Escape
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  // Sanitize raw SVG
  const sanitized = useMemo(() => {
    if (!rawSvg) return "";
    return sanitizeSvg(rawSvg);
  }, [rawSvg]);

  // Extract dimensions or viewBox if available
  const dimensions = useMemo(() => {
    if (!rawSvg) return null;
    const vbMatch = rawSvg.match(/viewBox\s*=\s*["']([^"']+)["']/i);
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/);
      if (parts.length === 4) {
        return `${parts[2]}×${parts[3]}`;
      }
    }
    const wMatch = rawSvg.match(/width\s*=\s*["']([^"']+)["']/i);
    const hMatch = rawSvg.match(/height\s*=\s*["']([^"']+)["']/i);
    if (wMatch && hMatch) {
      return `${wMatch[1]}×${hMatch[1]}`;
    }
    return null;
  }, [rawSvg]);

  const handleCopy = () => {
    if (!rawSvg) return;
    navigator.clipboard.writeText(rawSvg);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!rawSvg) return;
    const blob = new Blob([rawSvg], { type: "image/svg+xml;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    const cleanTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    a.download = cleanTitle.endsWith(".svg") ? cleanTitle : `${cleanTitle}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(3.0, parseFloat((z + 0.25).toFixed(2))));
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, parseFloat((z - 0.25).toFixed(2))));
  const handleResetZoom = () => setZoom(1.0);

  const bgClasses: Record<BgMode, string> = {
    white: "bg-white",
    dark: "bg-zinc-950",
    grid: "bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] dark:bg-[radial-gradient(#3f3f46_1px,transparent_1px)] [background-size:16px_16px] bg-slate-50 dark:bg-zinc-900"
  };

  const contentMarkup = (
    <div
      className={`rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden flex flex-col transition-all ${
        isFullscreen
          ? "fixed inset-4 sm:inset-8 z-50 shadow-2xl max-h-[calc(100vh-2rem)] sm:max-h-[calc(100vh-4rem)]"
          : className
      }`}
    >
      {/* 1. Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-white dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 text-xs">
        {/* Left: Title & Metadata Badge */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-zinc-100 truncate">
            <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="truncate max-w-[200px] sm:max-w-xs">{title}</span>
          </div>
          {dimensions && (
            <span className="hidden xs:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700">
              {dimensions}
            </span>
          )}
        </div>


        {/* Center / Right: Action controls */}
        <div className="flex items-center gap-1.5 flex-wrap ml-auto">
          {/* Tab Switcher */}
          <div className="flex items-center rounded-lg bg-slate-200/70 dark:bg-zinc-800 p-0.5 text-[11px] font-medium">
            <button
              type="button"
              onClick={() => setActiveTab("preview")}
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
                activeTab === "preview"
                  ? "bg-white dark:bg-zinc-700 text-emerald-700 dark:text-emerald-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
              }`}
            >
              <Eye className="h-3 w-3" />
              <span>Preview</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("code")}
              className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${
                activeTab === "code"
                  ? "bg-white dark:bg-zinc-700 text-emerald-700 dark:text-emerald-300 shadow-xs font-semibold"
                  : "text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200"
              }`}
            >
              <Code className="h-3 w-3" />
              <span>Code</span>
            </button>
          </div>

          {/* Background Mode Toggle (only relevant in preview) */}
          {activeTab === "preview" && (
            <div className="hidden sm:flex items-center rounded-lg bg-slate-200/70 dark:bg-zinc-800 p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setBgMode("white")}
                title="Crisp White Canvas"
                className={`px-1.5 py-0.5 rounded ${
                  bgMode === "white"
                    ? "bg-white text-slate-900 shadow-xs font-bold"
                    : "text-slate-500 hover:text-slate-800 dark:text-zinc-400"
                }`}
              >
                White
              </button>
              <button
                type="button"
                onClick={() => setBgMode("dark")}
                title="Dark Canvas"
                className={`px-1.5 py-0.5 rounded ${
                  bgMode === "dark"
                    ? "bg-zinc-950 text-white shadow-xs font-bold"
                    : "text-slate-500 hover:text-slate-800 dark:text-zinc-400"
                }`}
              >
                Dark
              </button>
              <button
                type="button"
                onClick={() => setBgMode("grid")}
                title="Transparency Grid"
                className={`px-1.5 py-0.5 rounded ${
                  bgMode === "grid"
                    ? "bg-slate-300 dark:bg-zinc-600 text-slate-900 dark:text-white shadow-xs font-bold"
                    : "text-slate-500 hover:text-slate-800 dark:text-zinc-400"
                }`}
              >
                Grid
              </button>
            </div>
          )}

          {/* Zoom controls (preview mode only) */}
          {activeTab === "preview" && (
            <div className="flex items-center gap-0.5 bg-slate-200/70 dark:bg-zinc-800 rounded-lg p-0.5 text-[11px] font-mono">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={zoom <= 0.5}
                title="Zoom Out"
                className="p-1 rounded hover:bg-white dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 disabled:opacity-40"
              >
                <ZoomOut className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={handleResetZoom}
                title="Reset Zoom to 100%"
                className="px-1.5 py-0.5 rounded hover:bg-white dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 text-[10px]"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={zoom >= 3.0}
                title="Zoom In"
                className="p-1 rounded hover:bg-white dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 disabled:opacity-40"
              >
                <ZoomIn className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Copy Button */}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-slate-50 dark:hover:bg-zinc-750 text-slate-700 dark:text-zinc-300 text-[11px] transition-colors"
            title="Copy SVG"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 text-[10px]">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 text-slate-500" />
                <span className="hidden sm:inline text-[10px]">Copy</span>
              </>
            )}
          </button>

          {/* Download Button */}
          <button
            type="button"
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-slate-50 dark:hover:bg-zinc-750 text-slate-700 dark:text-zinc-300 text-[11px] transition-colors"
            title="Download SVG file"
          >
            <Download className="h-3 w-3 text-slate-500" />
            <span className="hidden sm:inline text-[10px]">Download</span>
          </button>

          {/* Fullscreen Toggle */}
          {allowFullscreen && (
            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-slate-50 dark:hover:bg-zinc-750 text-slate-700 dark:text-zinc-300 text-[11px] transition-colors"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen Preview"}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3 w-3" />
              ) : (
                <Maximize2 className="h-3 w-3" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* 2. Main Content Viewport */}
      <div className="relative flex-1 min-h-[220px] max-h-[500px] overflow-auto flex flex-col items-center justify-center">
        {loading ? (
          <div className="py-12 flex flex-col items-center gap-2 text-slate-500 dark:text-zinc-400">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
            <span className="text-xs font-mono">Loading SVG stream...</span>
          </div>
        ) : fetchError ? (
          <div className="py-8 px-4 flex flex-col items-center text-center gap-2 text-rose-600 dark:text-rose-400">
            <AlertCircle className="h-6 w-6" />
            <span className="text-xs font-medium">Failed to render SVG</span>
            <span className="text-[11px] text-slate-500 dark:text-zinc-400 max-w-sm">{fetchError}</span>
          </div>
        ) : activeTab === "preview" ? (
          <div
            className={`w-full h-full min-h-[240px] flex items-center justify-center p-4 overflow-auto transition-colors ${
              bgClasses[bgMode]
            }`}
          >
            <div
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "center center",
                transition: "transform 0.15s ease-out"
              }}
              className="flex items-center justify-center max-w-full [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:block"
              dangerouslySetInnerHTML={{ __html: sanitized }}
            />
          </div>
        ) : (
          <div className="w-full h-full bg-slate-900 dark:bg-black p-3.5 overflow-auto">
            <pre className="text-[11px] font-mono text-emerald-300/90 whitespace-pre leading-relaxed">
              <code>{rawSvg}</code>
            </pre>
          </div>
        )}
      </div>

      {/* 3. Footer Bar */}
      <div className="px-3 py-1.5 bg-white dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-800 text-[10px] text-slate-500 dark:text-zinc-400 flex items-center justify-between gap-2">
        <span className="font-mono truncate">SVG Vector Format • Scalable</span>
        {activeTab === "preview" && (
          <span className="hidden sm:inline text-slate-400 dark:text-zinc-500 shrink-0">
            Click +/- or zoom buttons to inspect details
          </span>
        )}
      </div>

    </div>
  );

  if (isFullscreen) {
    return (
      <>
        {/* Backdrop overlay */}
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-xs z-40 animate-in fade-in duration-150"
          onClick={() => setIsFullscreen(false)}
        />
        {contentMarkup}
      </>
    );
  }

  return contentMarkup;
}

/**
 * File link card for markdown links pointing to SVG files
 */
export function SvgFileCard({
  src,
  alt,
  title
}: {
  src: string;
  alt?: string;
  title?: string;
}) {
  const displayTitle = title || alt || src.split("/").pop() || "Vector Graphic";

  return (
    <div className="my-3">
      <SvgViewer
        url={src}
        title={displayTitle}
        initialTab="preview"
        allowFullscreen={true}
      />
    </div>
  );
}

/**
 * Interactive chip/link for markdown links pointing to SVG files
 */
export function SvgFileLink({
  href,
  rawHref,
  children
}: {
  href: string;
  rawHref?: string;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showInline, setShowInline] = useState(false);
  const title = typeof children === "string" ? children : rawHref || href.split("/").pop() || "SVG File";

  return (
    <span className="inline-flex flex-col my-1 max-w-full align-middle">
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 text-xs shadow-xs font-mono">
        <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <span className="font-semibold truncate max-w-[200px] sm:max-w-xs">{title}</span>
        <button
          type="button"
          onClick={() => setShowInline(!showInline)}
          className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-200/60 dark:bg-emerald-800/60 hover:bg-emerald-300 dark:hover:bg-emerald-700 text-emerald-950 dark:text-emerald-100 transition-colors font-sans cursor-pointer"
        >
          {showInline ? "Hide" : "Preview"}
        </button>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors font-sans cursor-pointer"
        >
          Inspect
        </button>
      </span>

      {showInline && (
        <span className="mt-2 block w-full max-w-xl">
          <SvgViewer
            url={href}
            title={title}
            initialTab="preview"
          />
        </span>
      )}

      {isOpen && (
        <span
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 cursor-default"
          onClick={() => setIsOpen(false)}
        >
          <span
            className="w-full max-w-4xl max-h-[90vh] bg-white dark:bg-zinc-900 rounded-2xl overflow-hidden shadow-2xl block"
            onClick={(e) => e.stopPropagation()}
          >
            <SvgViewer
              url={href}
              title={title}
              initialTab="preview"
              allowFullscreen={false}
              className="h-[80vh]"
            />
          </span>
        </span>
      )}
    </span>
  );
}

