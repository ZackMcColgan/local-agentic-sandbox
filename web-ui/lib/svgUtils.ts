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

      // In non-code-fence text, find <svg ... > ... </svg>
      // and wrap it in ```svg\n...\n```
      return part.replace(
        /(<svg\b[^>]*>[\s\S]*?<\/svg>)/gi,
        (match) => `\n\`\`\`svg\n${match}\n\`\`\`\n`
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
