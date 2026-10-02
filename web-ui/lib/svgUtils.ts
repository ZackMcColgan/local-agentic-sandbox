/**
 * SVG Utility and Sanitization Library for local-agentic-sandbox UI
 */

export function isSvgCode(code: string, language?: string): boolean {
  if (!code || typeof code !== "string") return false;
  const lang = (language || "").trim().toLowerCase();
  if (lang === "svg") return true;

  const trimmed = code.trim();
  // Check if it's xml or html containing an <svg element
  if (lang === "xml" || lang === "html" || lang === "" || lang === "bash") {
    if (/<svg[\s>]/i.test(trimmed) && /<\/svg>/i.test(trimmed)) {
      return true;
    }
  }

  // Any code that starts with <svg ... or <?xml ... <svg ...
  if (/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(trimmed) && /<\/svg>/i.test(trimmed)) {
    return true;
  }

  return false;
}

export function sanitizeSvg(svgString: string): string {
  if (!svgString || typeof svgString !== "string") return "";

  let cleaned = svgString;

  // 1. Remove <script> tags and everything inside them
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  // 2. Remove inline event handlers (onload, onclick, onerror, onmouseover, etc.)
  cleaned = cleaned.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // 3. Remove javascript: pseudo-protocol in href, xlink:href, or src
  cleaned = cleaned.replace(/(href|xlink:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, "$1=\"#\"");

  return cleaned.trim();
}

export function wrapRawSvgInMarkdown(content: string): string {
  if (!content || typeof content !== "string") return "";

  // If the content is already fully wrapped in code fences, do not wrap
  // Split by code fences ```...```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part) => {
      // If this part is a code fence, keep it untouched
      if (part.startsWith("```")) {
        return part;
      }

      // In non-code-fence text, find <svg ... > ... </svg> (including optional xml/doctype prefixes)
      // and wrap it in ```svg\n...\n```
      return part.replace(
        /((?:<\?xml\b[^>]*\?>\s*)?(?:<!DOCTYPE\b[^>]*>\s*)?<svg\b[^>]*>[\s\S]*?<\/svg>)/gi,
        (match) => `\n\`\`\`svg\n${match.trim()}\n\`\`\`\n`
      );
    })
    .join("");
}

export function isSvgFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  // Strip query parameters and hash
  const cleanPath = filePath.split("?")[0].split("#")[0].trim().toLowerCase();
  return cleanPath.endsWith(".svg");
}

export function resolveSvgUrl(src: string): string {
  if (!src || typeof src !== "string") return "";
  const trimmed = src.trim();

  // If data URI or http/https or already /api/ route, return as-is
  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/api/")
  ) {
    return trimmed;
  }

  // Strip leading slash or relative prefix
  const clean = trimmed.replace(/^\.?\//, "");
  return `/api/files?path=${encodeURIComponent(clean)}`;
}

export interface ExtractedSvgItem {
  id: string;
  title: string;
  code?: string;
  url?: string;
}

/**
 * Extracts all SVG diagrams generated or retrieved by tool traces in a chat message.
 * This guarantees that when a tool like workspace_write_file, workspace_read_file,
 * or a CLI script writes or outputs an SVG, it renders immediately inline in the chat bubble.
 */
export function extractSvgsFromMessage(message: {
  id: string;
  content: string;
  traces?: Array<{
    tool: string;
    args?: Record<string, any>;
    result?: any;
  }>;
}): ExtractedSvgItem[] {
  const svgs: ExtractedSvgItem[] = [];
  const seenKeys = new Set<string>();

  if (!message.traces || !Array.isArray(message.traces)) {
    return svgs;
  }

  for (let i = 0; i < message.traces.length; i++) {
    const trace = message.traces[i];
    const pathArg = (trace.args?.path || trace.args?.file || trace.args?.filename || "") as string;
    const contentArg = (trace.args?.content || trace.args?.code || "") as string;
    const isPathSvg = pathArg ? isSvgFilePath(pathArg) : false;

    // Check stdout / result output
    let stdoutSvg = "";
    try {
      if (trace.result?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(trace.result.content[0].text);
          stdoutSvg = parsed.content || parsed.stdout || parsed.output || (typeof parsed === "string" ? parsed : "");
        } catch {
          stdoutSvg = trace.result.content[0].text;
        }
      } else if (typeof trace.result === "string") {
        stdoutSvg = trace.result;
      }
    } catch {
      stdoutSvg = "";
    }

    if (stdoutSvg && (stdoutSvg.includes("<svg") || isSvgCode(stdoutSvg))) {
      if (/^\s*\d+\s*\|/m.test(stdoutSvg)) {
        stdoutSvg = stdoutSvg.replace(/^\s*\d+\s*\|\s*/gm, "");
      }
    } else {
      stdoutSvg = "";
    }

    let code: string | undefined = undefined;
    if (contentArg && (isSvgCode(contentArg) || isPathSvg)) {
      code = contentArg;
    } else if (stdoutSvg && isSvgCode(stdoutSvg)) {
      code = stdoutSvg;
    }

    if (code || isPathSvg) {
      const title = pathArg ? pathArg.split(/[/\\]/).pop() || pathArg : `${trace.tool} Vector Graphic`;
      const key = pathArg || (code ? code.slice(0, 100) : `trace-${i}`);

      const alreadyInContent = code && code.length > 30 && message.content.includes(code.slice(0, 50));

      if (!seenKeys.has(key) && !alreadyInContent) {
        seenKeys.add(key);
        if (pathArg) seenKeys.add(pathArg);
        if (code) seenKeys.add(code.slice(0, 100));

        svgs.push({
          id: `${message.id}-trace-${i}`,
          title: title || "Vector Graphic",
          code,
          url: pathArg ? resolveSvgUrl(pathArg) : undefined
        });
      }
    }
  }

  return svgs;
}
