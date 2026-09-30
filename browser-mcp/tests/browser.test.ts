import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBrowserTools, htmlToMarkdown } from "../src/tools/browser.js";

describe("Browser MCP Toolchain Suite", () => {
  let mcp: McpServer;

  beforeEach(() => {
    mcp = new McpServer({
      name: "test-browser-mcp",
      version: "1.0.0"
    });
  });

  describe("Tool Registration", () => {
    it("registers search_web and fetch_webpage_markdown tools", () => {
      registerBrowserTools(mcp);
      // @ts-ignore
      const tools = mcp._registeredTools;
      assert.ok(tools["search_web"], "search_web should be registered");
      assert.ok(tools["fetch_webpage_markdown"], "fetch_webpage_markdown should be registered");
    });
  });

  describe("SSRF Security Boundary", () => {
    it("blocks SSRF attempts to localhost and loopback IPs", async () => {
      registerBrowserTools(mcp);
      // @ts-ignore
      const toolHandler = mcp._registeredTools["fetch_webpage_markdown"].handler;

      const testUrls = [
        "http://localhost:3000/secret",
        "http://127.0.0.1:8080/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/router",
        "http://192.168.1.1/gateway"
      ];

      for (const url of testUrls) {
        const result = await toolHandler({ url });
        assert.ok(result.content, "Result content should be defined");
        const parsed = JSON.parse(result.content[0].text);
        assert.equal(parsed.status, "BLOCKED_SSRF", `URL ${url} must be blocked by SSRF guard`);
      }
    });
  });

  describe("HTML to Markdown Parser", () => {
    it("strips scripts and formats headings and paragraphs cleanly", () => {
      const sampleHtml = `
        <html>
          <head><script>alert('malicious')</script><style>.hidden{display:none}</style></head>
          <body>
            <h1>Documentation Title</h1>
            <p>This is a paragraph explaining the API.</p>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
          </body>
        </html>
      `;

      const markdown = htmlToMarkdown(sampleHtml);
      assert.ok(!markdown.includes("alert"), "Scripts must be stripped");
      assert.ok(!markdown.includes("display:none"), "Styles must be stripped");
      assert.ok(markdown.includes("Documentation Title"));
      assert.ok(markdown.includes("This is a paragraph explaining the API."));
      assert.ok(markdown.includes("* Item 1"));
      assert.ok(markdown.includes("* Item 2"));
    });
  });
});
