import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function isPrivateIpOrLocalhost(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();

    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "169.254.169.254" // Cloud metadata endpoint
    ) {
      return true;
    }

    // Check private IPv4 subnets
    const parts = host.split(".").map(Number);
    if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      if (parts[0] === 10) return true; // 10.0.0.0/8
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
      if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    }

    return false;
  } catch {
    return true;
  }
}

export function htmlToMarkdown(html: string): string {
  // Strip non-content tags
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");

  // Format headers
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n\n### $1\n\n");

  // Format paragraphs & line breaks
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, "\n\n$1\n\n");
  text = text.replace(/<br\s*[\/]?>/gi, "\n");
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "\n* $1");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode standard HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Clean excessive whitespace
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .trim();
}

export function registerBrowserTools(mcp: McpServer) {
  // Tool 1: Search the web
  mcp.tool(
    "search_web",
    "Search the public internet using DuckDuckGo for live facts, current events, technical documentation, library APIs, or web information.",
    {
      query: z.string().describe("Search keywords or technical question (e.g. 'latest PyTorch release notes', 'pydantic v2 field validator syntax')"),
      limit: z.number().min(1).max(10).optional().default(5).describe("Maximum number of search results to return")
    },
    async ({ query, limit }) => {
      try {
        const results: Array<{ title: string; snippet: string; url: string }> = [];

        // DuckDuckGo Lite Search (POST method, scriptless, zero CAPTCHAs)
        const searchUrl = "https://lite.duckduckgo.com/lite/";
        const res = await fetch(searchUrl, {
          method: "POST",
          body: new URLSearchParams({ q: query }),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          },
          signal: AbortSignal.timeout(5000)
        });

        if (res.ok) {
          const html = await res.text();
          const linkRegex = /<a\s+[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
          const snippetRegex = /<td\s+[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

          const links: Array<{ title: string; url: string }> = [];
          let m;
          while ((m = linkRegex.exec(html)) !== null) {
            const fullTag = m[0];
            const title = m[1].replace(/<[^>]+>/g, "").trim();
            const hrefMatch = fullTag.match(/href=['"]([^'"]+)['"]/i);
            if (hrefMatch) {
              let targetUrl = hrefMatch[1];
              const uddg = targetUrl.match(/[?&]uddg=([^&]+)/);
              if (uddg) targetUrl = decodeURIComponent(uddg[1]);
              links.push({ title, url: targetUrl });
            }
          }

          const snippets: string[] = [];
          while ((m = snippetRegex.exec(html)) !== null) {
            snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
          }

          const targetLimit = limit || 5;
          for (let i = 0; i < links.length && results.length < targetLimit; i++) {
            results.push({
              title: links[i].title,
              snippet: snippets[i] || "Click to fetch full page content.",
              url: links[i].url
            });
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              query,
              count: results.length,
              results: results.length > 0 ? results : [{
                title: "Fallback Notice",
                snippet: `Query submitted for '${query}'. Use fetch_webpage_markdown to inspect direct URLs.`,
                url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
              }]
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SEARCH_ERROR",
              error: err.message,
              query
            }, null, 2)
          }]
        };
      }
    }
  );

  // Tool 2: Scrape web page to clean markdown
  mcp.tool(
    "fetch_webpage_markdown",
    "Fetch a public web page or documentation URL and convert its HTML content into clean, readable Markdown.",
    {
      url: z.string().url().describe("Target documentation or website URL to scrape (must be public HTTP/HTTPS)")
    },
    async ({ url }) => {
      if (isPrivateIpOrLocalhost(url)) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "BLOCKED_SSRF",
              error: "Access to private or local network hosts is strictly prohibited by security policy.",
              url
            }, null, 2)
          }]
        };
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          }
        });
        clearTimeout(timeout);

        if (!res.ok) {
          throw new Error(`Target returned HTTP status ${res.status}`);
        }

        const rawHtml = await res.text();
        const markdown = htmlToMarkdown(rawHtml);
        const truncated = markdown.length > 25000 ? markdown.substring(0, 25000) + "\n\n...[Content truncated for context window]" : markdown;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "SUCCESS",
              url,
              char_count: truncated.length,
              markdown: truncated
            }, null, 2)
          }]
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "FETCH_ERROR",
              error: err.message,
              url
            }, null, 2)
          }]
        };
      }
    }
  );
}
