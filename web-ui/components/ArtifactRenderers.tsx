"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { SvgViewer } from "./SvgViewer";
import { isSvgCode } from "../lib/svgUtils";

export function highlightTokens(code: string, language?: string): React.ReactNode[] {
  // Simple, ultra-clean zero-dependency token highlighting for key languages
  const lines = code.split("\n");
  const lang = (language || "").toLowerCase();

  return lines.map((line, lineIdx) => {
    // If language is xml / svg / html
    if (lang === "xml" || lang === "svg" || lang === "html") {
      const parts = line.split(/(<\/?[a-zA-Z0-9:-]+|"[^"]*"|'[^']*'|\/>|>)/g);
      return (
        <span key={lineIdx} className="block leading-5">
          {parts.map((p, pIdx) => {
            if (/^<\/?[a-zA-Z0-9:-]+$/.test(p)) {
              return <span key={pIdx} className="text-emerald-700 dark:text-emerald-400 font-semibold">{p}</span>;
            }
            if (/^["'].*["']$/.test(p)) {
              return <span key={pIdx} className="text-emerald-600 dark:text-emerald-400">{p}</span>;
            }
            if (p === ">" || p === "/>") {
              return <span key={pIdx} className="text-slate-500 dark:text-zinc-500 font-semibold">{p}</span>;
            }
            return <span key={pIdx}>{p}</span>;
          })}
        </span>
      );
    }

    // If language is json
    if (lang === "json") {
      const parts = line.split(/("[^"]*"\s*:|"[^"]*"|\b(?:true|false|null|\d+)\b)/g);
      return (
        <span key={lineIdx} className="block leading-5">
          {parts.map((p, pIdx) => {
            if (/^"[^"]*"\s*:$/.test(p)) {
              return <span key={pIdx} className="text-sky-700 dark:text-sky-400 font-semibold">{p}</span>;
            }
            if (/^"[^"]*"$/.test(p)) {
              return <span key={pIdx} className="text-emerald-600 dark:text-emerald-400">{p}</span>;
            }
            if (/^(?:true|false|null|\d+)$/.test(p)) {
              return <span key={pIdx} className="text-amber-600 dark:text-amber-400 font-bold">{p}</span>;
            }
            return <span key={pIdx}>{p}</span>;
          })}
        </span>
      );
    }

    // General typescript / javascript / python / bash keywords
    const keywordRegex = /\b(const|let|var|function|return|import|from|export|default|class|interface|type|async|await|if|else|for|while|try|catch|def|print|self|None|True|False)\b|("[^"]*"|'[^']*'|`[^`]*`)|(\/\/.*$|#.*$)/g;
    const tokens: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = keywordRegex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        tokens.push(line.slice(lastIndex, match.index));
      }
      if (match[1]) {
        // Keyword
        tokens.push(<span key={match.index} className="text-emerald-700 dark:text-emerald-400 font-semibold">{match[1]}</span>);
      } else if (match[2]) {
        // String literal
        tokens.push(<span key={match.index} className="text-emerald-600 dark:text-emerald-400">{match[2]}</span>);
      } else if (match[3]) {
        // Comment
        tokens.push(<span key={match.index} className="text-slate-400 dark:text-zinc-500 italic">{match[3]}</span>);
      }
      lastIndex = keywordRegex.lastIndex;
    }
    if (lastIndex < line.length) {
      tokens.push(line.slice(lastIndex));
    }

    return (
      <span key={lineIdx} className="block leading-5">
        {tokens.length > 0 ? tokens : line}
      </span>
    );
  });
}

export interface CodeBlockProps {
  language?: string;
  code: string;
  filename?: string;
}

export function CodeBlock({ language, code, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"preview" | "code">("preview");

  const isSvg = isSvgCode(code, language);
  const isHtml = language === "html" || (code.trim().startsWith("<!DOCTYPE html") || code.trim().startsWith("<html"));
  const langDisplay = language ? language.toLowerCase() : (isSvg ? "svg" : "bash");
  const lines = code.split("\n");
  const showLineNumbers = lines.length >= 3;
  const isLong = lines.length > 20;

  const handleCopy = async () => {
    const ok = await copyText(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // If this is an SVG and user hasn't toggled away, SvgViewer handles preview + code
  if (isSvg) {
    return (
      <div className="my-3">
        <SvgViewer
          code={code}
          title={filename || `${langDisplay.toUpperCase()} Vector Graphic`}
          initialTab="preview"
          allowFullscreen={true}
        />
      </div>
    );
  }

  // If this is standalone HTML, support Preview | Code tabs with sandboxed iframe
  if (isHtml) {
    return (
      <div className="my-3 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-3.5 py-2 bg-slate-50 dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 text-[11px] font-mono text-slate-600 dark:text-zinc-400">
          <div className="flex items-center gap-2">
            <span className="text-emerald-700 dark:text-emerald-400 font-semibold">{filename || "index.html"}</span>
            <div className="flex items-center rounded-lg bg-slate-200/70 dark:bg-zinc-800 p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setActiveTab("preview")}
                className={`px-2 py-0.5 rounded ${activeTab === "preview" ? "bg-white dark:bg-zinc-700 text-emerald-800 dark:text-emerald-300 font-bold" : "text-slate-500 dark:text-zinc-400"}`}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("code")}
                className={`px-2 py-0.5 rounded ${activeTab === "code" ? "bg-white dark:bg-zinc-700 text-emerald-800 dark:text-emerald-300 font-bold" : "text-slate-500 dark:text-zinc-400"}`}
              >
                Code
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isLong && activeTab === "code" && (
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="hover:text-slate-900 dark:hover:text-white transition-colors text-[10px] font-medium"
                title={isExpanded ? "Collapse code block" : "Expand code block"}
              >
                {isExpanded ? "Collapse" : "Expand"}
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white transition-colors"
              title="Copy code"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
        </div>

        {activeTab === "preview" ? (
          <div className="p-2 bg-white dark:bg-zinc-950 min-h-[220px]">
            <iframe
              srcDoc={code}
              sandbox="allow-scripts"
              className="w-full h-64 border-0 rounded-xl bg-white"
              title="HTML Artifact Preview"
            />
          </div>
        ) : (
          <div className="relative">
            <div
              className={`flex overflow-x-auto text-xs font-mono p-3.5 leading-relaxed bg-slate-50 dark:bg-zinc-900 ${
                !isExpanded && isLong ? "max-h-[400px] overflow-y-auto" : ""
              }`}
            >
              {showLineNumbers && (
                <div className="select-none pr-3.5 mr-3.5 border-r border-slate-200 dark:border-zinc-800 text-slate-400 dark:text-zinc-600 text-right text-[11px] font-mono leading-5">
                  {lines.map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
              )}
              <pre className="overflow-x-auto text-slate-900 dark:text-zinc-100 flex-1">
                <code>{highlightTokens(code, langDisplay)}</code>
              </pre>
            </div>
            {!isExpanded && isLong && (
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-slate-50 dark:from-zinc-900 to-transparent"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-3 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-surface-variant bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
      <div className="flex items-center justify-between px-3.5 py-2 bg-slate-50 dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 text-[11px] font-mono text-slate-600 dark:text-zinc-400">
        <div className="flex items-center gap-2">
          {filename && <span className="font-semibold text-slate-800 dark:text-zinc-200">{filename}</span>}
          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">{langDisplay}</span>
          {isLong && (
            <span className="text-[10px] text-slate-500 dark:text-zinc-500">
              ({lines.length} lines)
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isLong && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="hover:text-slate-900 dark:hover:text-white transition-colors text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-zinc-800/80"
              title={isExpanded ? "Collapse code block" : "Expand code block"}
            >
              {isExpanded ? "Collapse" : "Expand"}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white transition-colors"
            title="Copy code"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="relative">
        <div
          className={`flex overflow-x-auto text-xs font-mono p-3.5 leading-relaxed bg-slate-50 dark:bg-zinc-900 ${
            !isExpanded && isLong ? "max-h-[400px] overflow-y-auto" : ""
          }`}
        >
          {showLineNumbers && (
            <div className="select-none pr-3.5 mr-3.5 border-r border-slate-200 dark:border-zinc-800 text-slate-400 dark:text-zinc-600 text-right text-[11px] font-mono leading-5">
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
          )}
          <pre className="overflow-x-auto text-slate-900 dark:text-zinc-100 flex-1">
            <code data-code={code}>{highlightTokens(code, langDisplay)}</code>
          </pre>
        </div>
        {!isExpanded && isLong && (
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-slate-50 dark:from-zinc-900 to-transparent"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

export const CodeBlockWithCopy = CodeBlock;

export function SvgRendererBlock({
  code,
  title,
  initialTab = "preview",
  allowFullscreen = true
}: {
  code: string;
  title?: string;
  initialTab?: "preview" | "code";
  allowFullscreen?: boolean;
}) {
  return (
    <div className="my-3">
      <SvgViewer
        code={code}
        title={title || "SVG Vector Graphic"}
        initialTab={initialTab}
        allowFullscreen={allowFullscreen}
      />
    </div>
  );
}

export function MermaidBlock({
  code,
  title
}: {
  code: string;
  title?: string;
}) {
  return (
    <CodeBlock
      language="mermaid"
      code={code}
      filename={title || "diagram.mmd"}
    />
  );
}
