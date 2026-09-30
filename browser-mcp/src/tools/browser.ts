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
    "Search the public internet using DuckDuckGo for live facts, current events, weather forecasts, technical documentation, or web pages.",
    {
      query: z.string().describe("Search keywords or technical question (e.g. 'Austin TX weather today', 'pydantic v2 validator')"),
      limit: z.number().min(1).max(10).optional().default(5).describe("Maximum number of search results to return")
    },
    async ({ query, limit }) => {
      try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
          }
        });

        if (!res.ok) {
          throw new Error(`Search provider returned HTTP ${res.status}`);
        }

        const html = await res.text();
        // Extract basic search snippets from HTML response
        const results: Array<{ title: string; snippet: string; url: string }> = [];
        const resultRegex = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < (limit || 5)) {
          let rawUrl = match[1].trim();
          const rawSnippet = match[2].replace(/<[^>]+>/g, "").trim();

          // Unwrap DuckDuckGo redirect uddg parameter
          const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
          if (uddgMatch) {
            rawUrl = decodeURIComponent(uddgMatch[1]);
          } else if (!rawUrl.startsWith("http")) {
            rawUrl = `https://${rawUrl.replace(/^\/+/, "")}`;
          }

          results.push({
            title: `Result ${results.length + 1}`,
            snippet: rawSnippet,
            url: rawUrl
          });
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
                url: searchUrl
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
